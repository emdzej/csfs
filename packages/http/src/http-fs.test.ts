import { describe, expect, it } from "vitest";
import { NotDataError, RangeUnsupportedError } from "@emdzej/csfs-core";
import type { Manifest } from "@emdzej/csfs-manifest";
import { httpFileSystem } from "./index.js";

const MANIFEST: Manifest = {
  csfs: 1,
  files: {
    "/a.txt": 5,
    "/deep/nested/b.bin": 256,
    "/only.zip": 100,
  },
  archives: [{ archive: "/only.zip", serves: "/mounted", entry: "basename" }],
};

/**
 * A fetch that serves the manifest and honours `Range` over a byte pattern.
 *
 * Range handling is modelled rather than faked because it is the thing worth
 * testing: a backend that quietly ignores an offset would pass any test that
 * only checked lengths.
 */
function serving(
  bodies: Record<string, Uint8Array>,
  opts: { ignoreRange?: boolean; html?: boolean } = {},
) {
  const calls: { url: string; range?: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    calls.push({ url, ...(range !== undefined ? { range } : {}) });

    if (opts.html) {
      return new Response("<!doctype html><title>404</title>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.endsWith("/csfs-manifest.json")) {
      return new Response(JSON.stringify(MANIFEST), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const path = new URL(url, "http://x").pathname;
    const body = bodies[path];
    if (!body) return new Response("nope", { status: 404 });

    if (!range || opts.ignoreRange) {
      // What a host without Range support does: 200 and the whole body.
      return new Response(body as unknown as BodyInit, { status: 200 });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(m[1]);
    const end = Number(m[2]) + 1;
    return new Response(body.subarray(start, end) as unknown as BodyInit, {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end - 1}/${body.byteLength}` },
    });
  }) as typeof globalThis.fetch;
  return { impl, calls };
}

const pattern = (n: number) => new Uint8Array(n).map((_, i) => i % 256);

describe("HttpFileSystem", () => {
  it("lists directories from the manifest, since HTTP cannot", async () => {
    const { impl } = serving({});
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    const root = await fs.directory("/");
    expect((await root!.entries()).map((e) => `${e.kind}:${e.name}`).sort()).toEqual([
      "directory:deep",
      "directory:mounted",
      "file:a.txt",
      "file:only.zip",
    ]);
    // Directories are derived from file paths, and `mounted` exists only
    // because an archive says it serves it.
    expect(await fs.directory("/deep/nested")).not.toBeNull();
    expect(await fs.directory("/absent")).toBeNull();
  });

  it("reads a byte range, and reads the right bytes", async () => {
    const body = pattern(256);
    const { impl, calls } = serving({ "/data/deep/nested/b.bin": body });
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    const file = await fs.file("/deep/nested/b.bin");
    expect(file!.size).toBe(256);
    expect(await file!.slice(10, 20).bytes()).toEqual(body.subarray(10, 20));
    // Slicing a slice composes by arithmetic, and costs nothing until read.
    expect(await file!.slice(10, 30).slice(5, 10).bytes()).toEqual(body.subarray(15, 20));
    expect(calls.filter((c) => c.range).map((c) => c.range)).toEqual([
      "bytes=10-19",
      "bytes=15-19",
    ]);
  });

  it("refuses a host that ignores Range rather than returning the wrong bytes", async () => {
    // The failure this prevents is silent: the body of a 200 is the *whole*
    // file, so using it as the requested slice yields wrong data with no error.
    const { impl } = serving({ "/data/a.txt": pattern(5) }, { ignoreRange: true });
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    const file = await fs.file("/a.txt");
    await expect(file!.slice(1, 3).bytes()).rejects.toThrow(RangeUnsupportedError);
  });

  it("rejects a web page served where data was expected", async () => {
    // A single-page app answers any unknown path with its own HTML and a 200,
    // so a mistyped base URL otherwise looks like a working tree.
    const { impl } = serving({}, { html: true });
    const fs = httpFileSystem("http://host/wrong", { fetch: impl });
    await expect(fs.file("/a.txt")).rejects.toThrow(NotDataError);
  });

  it("fetches the manifest once", async () => {
    const { impl, calls } = serving({ "/data/a.txt": pattern(5) });
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    await fs.file("/a.txt");
    await fs.directory("/");
    await fs.stat("/a.txt");
    expect(calls.filter((c) => c.url.endsWith("csfs-manifest.json"))).toHaveLength(1);
  });

  it("accepts a manifest supplied up front, and then fetches nothing to open", async () => {
    // For a consumer that bundled or cached it: opening a tree should be free.
    const { impl, calls } = serving({ "/data/a.txt": pattern(5) });
    const fs = httpFileSystem("http://host/data", { fetch: impl, manifest: MANIFEST });
    expect(await fs.stat("/a.txt")).toEqual({ kind: "file", name: "a.txt", size: 5 });
    expect(calls).toHaveLength(0);
  });

  it("gives a direct URL only for a file it knows about", async () => {
    // Returning a URL for anything asked would make this useless as an
    // existence test, and a caller wanting to fall back to an archive would
    // hold a URL that 404s — an `<img>` that never loads, with no error.
    const { impl } = serving({});
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    expect(await fs.directUrl("/a.txt")).toBe("http://host/data/a.txt");
    expect(await fs.directUrl("/absent.txt")).toBeNull();
  });

  it("reports absence as null, not as an error", async () => {
    const { impl } = serving({});
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    expect(await fs.file("/absent")).toBeNull();
    expect(await fs.stat("/absent")).toBeNull();
    expect(await fs.read("/absent")).toBeNull();
  });
});
