/**
 * The same tree, read two ways, compared byte for byte.
 *
 * This is the test that earns the abstraction. Each backend has its own tests,
 * but those only prove each is self-consistent — a backend that dropped the
 * first byte of every read would pass its own suite happily. What matters is
 * that a caller gets the *same answer* whichever way the tree is reached, so
 * this stands up a real HTTP server over a real directory, builds a manifest
 * with the real builder, and compares.
 *
 * The server is deliberately minimal and honours `Range` by hand, because a
 * framework that handled it would be testing the framework.
 */
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { walkFileSystem } from "@emdzej/csfs-core";
import { nodeFileSystem } from "@emdzej/csfs-node";
import { withArchives, withTransparentArchives } from "@emdzej/csfs-zip";
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import { buildManifest, formatManifest, MANIFEST_FILE } from "@emdzej/csfs-manifest";
import { httpFileSystem } from "./index.js";

let dir: string;
let server: Server;
let base: string;

/** A static server with `Range`, which is all csfs asks of a host. */
function serve(root: string): Promise<{ server: Server; base: string }> {
  const s = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = join(root, path);
    let size: number;
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      res.statusCode = 404;
      res.end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (!range) {
      res.statusCode = 200;
      res.setHeader("Content-Length", String(size));
      createReadStream(file).pipe(res);
      return;
    }
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(file, { start, end }).pipe(res);
  });
  return new Promise((resolve) => {
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server: s, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function makeZip(files: { name: string; text?: string; bytes?: Uint8Array }[]) {
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  for (const f of files) {
    await writer.add(
      f.name,
      f.bytes ? new Uint8ArrayReader(f.bytes) : new TextReader(f.text ?? ""),
    );
  }
  return new Uint8Array(await (await writer.close()).arrayBuffer());
}

const pattern = (n: number) => new Uint8Array(n).map((_, i) => (i * 7) % 256);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csfs-parity-"));
  await mkdir(join(dir, "deep", "nested"), { recursive: true });
  await writeFile(join(dir, "top.txt"), "at the top");
  await writeFile(join(dir, "deep", "nested", "big.bin"), pattern(300_000));
  await writeFile(join(dir, "deep", "note.txt"), "nested note");
  // A flat archive standing in for a nested tree, and one plain archive.
  await writeFile(
    join(dir, "drawings.zip"),
    await makeZip([
      { name: "1132C000.png", text: "a drawing" },
      { name: "1132C001.png", bytes: pattern(4096) },
    ]),
  );

  // Three archives serving one directory, which is how a multi-disc data set
  // ships: each disc has its own `images_1.zip`, none of them renamed.
  await writeFile(
    join(dir, "images_1.zip"),
    await makeZip([{ name: "one.png", bytes: pattern(1024) }]),
  );
  await writeFile(
    join(dir, "images_2.zip"),
    await makeZip([{ name: "two.png", bytes: pattern(2048) }]),
  );
  // `shared.png` is in an archive *and* extracted below, so precedence has
  // something to decide.
  await writeFile(
    join(dir, "images_3.zip"),
    await makeZip([
      { name: "three.png", bytes: pattern(3072) },
      { name: "shared.png", text: "the archived one" },
    ]),
  );
  await mkdir(join(dir, "images", "bucket"), { recursive: true });
  await writeFile(join(dir, "images", "bucket", "shared.png"), "the extracted one");

  const declared = [
    { archive: "/drawings.zip", serves: "/drawings", entry: "basename" as const },
    { archive: "/images_1.zip", serves: "/images", entry: "basename" as const },
    { archive: "/images_2.zip", serves: "/images", entry: "basename" as const },
    { archive: "/images_3.zip", serves: "/images", entry: "basename" as const },
  ];

  const manifest = await buildManifest(nodeFileSystem(dir), {
    builtAt: new Date(0).toISOString(),
    archives: declared,
    filter: (p) => !p.endsWith(`/${MANIFEST_FILE}`),
  });
  await writeFile(join(dir, MANIFEST_FILE), formatManifest(manifest));

  ({ server, base } = await serve(dir));
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

describe("HTTP and Node agree", () => {
  it("walks to the same set of files and sizes", async () => {
    const local = nodeFileSystem(dir);
    const remote = httpFileSystem(base);

    const collect = async (fs: Parameters<typeof walkFileSystem>[0]) => {
      const out: string[] = [];
      for await (const e of walkFileSystem(fs, "/")) out.push(`${e.path} ${e.size}`);
      return out.sort();
    };
    // The manifest is not in the manifest, by design, so it is excluded on the
    // local side too rather than being papered over here.
    const localList = (await collect(local)).filter((l) => !l.includes(MANIFEST_FILE));
    expect(await collect(remote)).toEqual(localList);
  });

  it("returns identical bytes for a whole file", async () => {
    const localBytes = await nodeFileSystem(dir).read("/deep/nested/big.bin");
    const remoteBytes = await httpFileSystem(base).read("/deep/nested/big.bin");
    expect(remoteBytes).toEqual(localBytes);
  });

  it("returns identical bytes for a range, at several offsets", async () => {
    const local = await nodeFileSystem(dir).file("/deep/nested/big.bin");
    const remote = await httpFileSystem(base).file("/deep/nested/big.bin");
    expect(remote).not.toBeNull();
    if (!remote || !local) return;
    // Offsets chosen to cross chunk boundaries and to end at the last byte,
    // which is where an inclusive/exclusive mistake shows up.
    for (const [start, end] of [
      [0, 1],
      [0, 65536],
      [1, 2],
      [12345, 12346],
      [299_999, 300_000],
      [250_000, 300_000],
    ] as const) {
      expect(await remote.slice(start, end).bytes()).toEqual(
        await local.slice(start, end).bytes(),
      );
    }
  });

  it("clamps an over-long range the same way on both", async () => {
    const local = await nodeFileSystem(dir).file("/top.txt");
    const remote = await httpFileSystem(base).file("/top.txt");
    expect(remote).not.toBeNull();
    if (!remote || !local) return;
    expect(await remote.slice(0, 1000).bytes()).toEqual(await local.slice(0, 1000).bytes());
    expect((await remote.slice(5, 4).bytes()).byteLength).toBe(0);
  });

  it("reads an archive in place over HTTP, and matches the local read", async () => {
    // The whole point of the range interface: zip.js reads the central
    // directory from the end of the file, so this works only if `Range`
    // composes correctly through the manifest, the file and the slice.
    const mounts = [
      { archive: "/drawings.zip", serves: "/drawings", entry: "basename" as const },
    ];
    const local = withTransparentArchives(nodeFileSystem(dir), mounts);
    const remote = withTransparentArchives(httpFileSystem(base), mounts);

    for (const path of ["/drawings/1132/1132C000.png", "/drawings/anywhere/1132C001.png"]) {
      const a = await local.read(path);
      const b = await remote.read(path);
      expect(b).not.toBeNull();
      expect(b).toEqual(a);
    }
  });

  it("reads through # addressing over HTTP", async () => {
    const remote = withArchives(httpFileSystem(base));
    const bytes = await remote.read("/drawings.zip#/1132C000.png");
    expect(new TextDecoder().decode(bytes!)).toBe("a drawing");
  });

  it("lists an archived directory over HTTP, from the manifest alone", async () => {
    const remote = httpFileSystem(base);
    // `/drawings` exists only because the manifest says an archive serves it.
    expect(await remote.directory("/drawings")).not.toBeNull();
    const root = await remote.directory("/");
    expect((await root!.entries()).map((e) => e.name)).toContain("drawings");
  });

  /*
   * The configuration a consumer actually assembles.
   *
   * The tests above hand `withTransparentArchives` a mount list written out
   * by hand, which checks the mount logic but not the part a consumer depends
   * on: that the mounts *come back out of the manifest* in the shape the
   * wrapper wants. `buildManifest({ archives })` writes them and `archives()`
   * reads them, and nothing until now has closed that loop — a disagreement
   * between the two would leave every mounted read returning null, with no
   * error to point at it.
   */
  describe("mounts round-tripped through the manifest", () => {
    /** Byte for byte what a consumer writes to open such a tree. */
    async function openAsAConsumerWould() {
      const remote = httpFileSystem(base);
      const archives = await remote.archives();
      return { fs: withTransparentArchives(withArchives(remote), archives), archives };
    }

    it("declares every archive it was built with", async () => {
      const { archives } = await openAsAConsumerWould();
      expect(archives.map((a) => a.archive).sort()).toEqual([
        "/drawings.zip",
        "/images_1.zip",
        "/images_2.zip",
        "/images_3.zip",
      ]);
      // `entry` has to survive the round trip. If it came back undefined it
      // would default to "relative", and every basename lookup would miss.
      expect(archives.every((a) => a.entry === "basename")).toBe(true);
    });

    it("reads from each of three archives serving one directory", async () => {
      const { fs } = await openAsAConsumerWould();
      const local = withTransparentArchives(nodeFileSystem(dir), [
        { archive: "/images_1.zip", serves: "/images", entry: "basename" },
        { archive: "/images_2.zip", serves: "/images", entry: "basename" },
        { archive: "/images_3.zip", serves: "/images", entry: "basename" },
      ]);
      // Nested paths that exist in no archive's own layout: each is found by
      // basename, in whichever archive happens to hold it.
      for (const [path, size] of [
        ["/images/bucket/one.png", 1024],
        ["/images/deeper/still/two.png", 2048],
        ["/images/three.png", 3072],
      ] as const) {
        const bytes = await fs.read(path);
        expect(bytes, path).not.toBeNull();
        expect(bytes!.byteLength, path).toBe(size);
        expect(bytes, path).toEqual(await local.read(path));
      }
    });

    it("returns null for a name in none of them, rather than the wrong file", async () => {
      const { fs } = await openAsAConsumerWould();
      expect(await fs.read("/images/bucket/absent.png")).toBeNull();
    });

    it("prefers the extracted file over the archived one of the same name", async () => {
      const { fs } = await openAsAConsumerWould();
      // A half-extracted tree is the normal state during an import, so the
      // real file has to win — otherwise a re-import silently keeps serving
      // stale bytes out of the archive.
      const bytes = await fs.read("/images/bucket/shared.png");
      expect(new TextDecoder().decode(bytes!)).toBe("the extracted one");
    });

    it("gives a direct URL for a real file and none for an archived one", async () => {
      const { fs } = await openAsAConsumerWould();
      // The distinction is the point. A real file can be handed to an <img>
      // or an <iframe> as a URL, which lets the browser range-request and
      // cache it; a 40 MB PDF fetched into a blob cannot show page one until
      // all of it has arrived.
      const real = await fs.directUrl?.("/top.txt");
      expect(real).toBe(`${base}/top.txt`);

      // Inside an archive there is no URL to give: the bytes are compressed
      // inside a larger file, and returning the archive's own URL would load
      // something else entirely. Null tells the caller to make a blob.
      expect(await fs.directUrl?.("/images/bucket/one.png")).toBeNull();
      expect(await fs.directUrl?.("/images_1.zip#/one.png")).toBeNull();
      expect(await fs.directUrl?.("/absent.txt")).toBeNull();
    });

    it("still reads a nested archive by # once mounts are in play", async () => {
      const { fs } = await openAsAConsumerWould();
      // `withArchives` under `withTransparentArchives`: both wrappers active
      // at once, which is the stack a consumer ends up with.
      const bytes = await fs.read("/images_3.zip#/three.png");
      expect(bytes?.byteLength).toBe(3072);
    });
  });
});
