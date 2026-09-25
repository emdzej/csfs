/**
 * The hosts a browser meets, each misbehaving in one documented way.
 *
 * Written by hand for the same reason as the parity suite's server: a
 * framework that handled `Range` would be testing the framework. Every route
 * serves the same tree; the prefix picks the behaviour.
 *
 * - `/data/`     honours `Range`.
 * - `/norange/`  ignores it and answers 200 with the whole body, as the
 *                bimmerz dongle's static handler does.
 * - `/spa/`      answers every path with a web page and a 200.
 * - `/gz/`       serves the manifest gzipped with no `Content-Encoding`.
 * - `/noexpose/` (cross-origin only) sends CORS headers but does not expose
 *                `Content-Range`, so a page cannot read it.
 * - `/trickle/<id>/` honours `Range` but sends a body 64 KB at a time with a
 *                pause between, and records at `/__trickle/<id>` how much it
 *                sent and whether the client hung up first. How an engine
 *                chunks a fast local body is its own business — WebKit on
 *                Linux hands over a megabyte at once — so streaming and
 *                cancelling are judged by what the *server* saw.
 *
 * The harness page is served at `/` of the same origin.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { gzipSync } from "node:zlib";
import { extname, join, normalize } from "node:path";
import { mimeType } from "@emdzej/csfs-core";
import { MANIFEST_FILE } from "@emdzej/csfs-manifest";

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

/** A path under a root, or null if it would leave it. */
function inside(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath);
  const full = normalize(join(root, decoded));
  return full.startsWith(normalize(root)) ? full : null;
}

/** What a trickled response got through before it ended. */
interface Trickle {
  sent: number;
  total: number;
  hungUp: boolean;
}

const trickles = new Map<string, Trickle>();

/** Write `[start, end]` of a file slowly, stopping if the client goes away. */
async function trickle(
  res: ServerResponse,
  file: string,
  start: number,
  end: number,
  record: Trickle,
): Promise<void> {
  const body = (await readFile(file)).subarray(start, end + 1);
  record.total = body.byteLength;
  res.on("close", () => {
    if (record.sent < record.total) record.hungUp = true;
  });
  for (let at = 0; at < body.byteLength; at += 65_536) {
    if (res.destroyed) return;
    const chunk = body.subarray(at, at + 65_536);
    await new Promise<void>((resolve) => res.write(chunk, () => resolve()));
    record.sent += chunk.byteLength;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  res.end();
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  opts: { ranges: boolean; trickle?: Trickle },
): Promise<void> {
  let size: number;
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    res.statusCode = 404;
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><h1>Not Found</h1>");
    return;
  }
  res.setHeader("content-type", mimeType(file));
  const range = opts.ranges ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "") : null;
  if (!range) {
    res.statusCode = 200;
    res.setHeader("content-length", String(size));
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
    return;
  }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size) {
    res.statusCode = 416;
    res.setHeader("content-range", `bytes */${size}`);
    return void res.end();
  }
  res.statusCode = 206;
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
  res.setHeader("content-length", String(end - start + 1));
  if (opts.trickle) return await trickle(res, file, start, end, opts.trickle);
  createReadStream(file, { start, end }).pipe(res);
}

function handler(
  tree: string,
  opts: { harness?: string; cors?: boolean },
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (opts.cors) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "range");
      if (!path.startsWith("/noexpose/")) {
        res.setHeader("access-control-expose-headers", "content-range, content-length");
      }
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        return void res.end();
      }
    }
    const stats = /^\/__trickle\/([\w-]+)$/.exec(path);
    if (stats) {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify(trickles.get(stats[1]!) ?? null));
    }
    const slow = /^\/trickle\/([\w-]+)(\/.*)$/.exec(path);
    if (slow) {
      const [, id, rest] = slow as unknown as [string, string, string];
      const file = inside(tree, rest);
      if (!file) return void res.writeHead(403).end();
      if (rest === `/${MANIFEST_FILE}`) return await sendFile(req, res, file, { ranges: true });
      const record: Trickle = { sent: 0, total: 0, hungUp: false };
      trickles.set(id, record);
      return await sendFile(req, res, file, { ranges: true, trickle: record });
    }
    const route = /^\/(data|norange|spa|gz|noexpose)(\/.*)$/.exec(path);
    if (!route) {
      if (!opts.harness) {
        res.statusCode = 404;
        return void res.end();
      }
      const file = inside(opts.harness, path === "/" ? "/index.html" : path);
      if (!file) return void res.writeHead(403).end();
      try {
        const body = await readFile(file);
        res.setHeader(
          "content-type",
          STATIC_TYPES[extname(file)] ?? "application/octet-stream",
        );
        return void res.end(body);
      } catch {
        return void res.writeHead(404).end();
      }
    }
    const [, kind, rest] = route as unknown as [string, string, string];
    if (kind === "spa") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return void res.end("<!doctype html><title>app</title><div id=app></div>");
    }
    const file = inside(tree, rest);
    if (!file) return void res.writeHead(403).end();
    if (kind === "gz" && rest === `/${MANIFEST_FILE}`) {
      res.setHeader("content-type", "application/octet-stream");
      return void res.end(gzipSync(await readFile(file)));
    }
    await sendFile(req, res, file, { ranges: kind !== "norange" });
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** The harness and its data on one origin, and the data again on another. */
export async function serve(tree: string, harness: string, demo: string) {
  const main = createServer(handler(tree, { harness }));
  const cross = createServer(handler(tree, { cors: true }));
  const site = createServer(handler(tree, { harness: demo }));
  const [origin, crossOrigin, demoOrigin] = await Promise.all([
    listen(main),
    listen(cross),
    listen(site),
  ]);
  return {
    origin,
    crossOrigin,
    demoOrigin,
    close: () =>
      Promise.all([main, cross, site].map((s) => new Promise<void>((r) => s.close(() => r())))),
  };
}
