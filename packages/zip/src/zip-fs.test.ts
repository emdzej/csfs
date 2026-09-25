import { openAsBlob } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  BackendError,
  BlobFile,
  NotDataError,
  RangeFile,
  type BlobLike,
  type CsFile,
  type CsFileSystem,
} from "@emdzej/csfs-core";
import { ZipWriter, BlobWriter, TextReader, Uint8ArrayReader } from "@zip.js/zip.js";
import { zipFileSystem } from "./zip-fs.js";
import { withArchives, withTransparentArchives } from "./archives.js";
import { nodeFileSystem } from "@emdzej/csfs-node";

/** Build a real archive with zip.js, so the fixture is not hand-rolled. */
async function makeZip(
  files: { name: string; text?: string; bytes?: Uint8Array }[],
): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  for (const f of files) {
    await writer.add(
      f.name,
      f.bytes ? new Uint8ArrayReader(f.bytes) : new TextReader(f.text ?? ""),
    );
  }
  const blob = await writer.close();
  return new Uint8Array(await blob.arrayBuffer());
}

const fileOf = (path: string, bytes: Uint8Array) =>
  new BlobFile(path, new Blob([bytes as unknown as BlobPart]) as unknown as BlobLike);

describe("ZipFileSystem", () => {
  it("synthesises directories the archive never stored", async () => {
    // Plenty of archives write no directory entries at all. A tree built only
    // from stored directories would lose every file inside them.
    const zip = await makeZip([
      { name: "deep/nested/one.txt", text: "one" },
      { name: "top.txt", text: "top" },
    ]);
    const fs = zipFileSystem(fileOf("/a.zip", zip));

    const root = await fs.directory("/");
    expect((await root!.entries()).map((e) => `${e.kind}:${e.name}`).sort()).toEqual([
      "directory:deep",
      "file:top.txt",
    ]);
    expect(await fs.directory("/deep/nested")).not.toBeNull();
    expect(await (await fs.file("/deep/nested/one.txt"))!.text()).toBe("one");
  });

  it("reports sizes and reads bytes back exactly", async () => {
    const payload = new Uint8Array(5000).map((_, i) => i % 251);
    const zip = await makeZip([{ name: "blob.bin", bytes: payload }]);
    const fs = zipFileSystem(fileOf("/a.zip", zip));
    const file = await fs.file("/blob.bin");
    expect(file!.size).toBe(5000);
    expect(await file!.bytes()).toEqual(payload);
    // Slicing a decompressed entry has to work like any other file.
    expect(await file!.slice(10, 20).bytes()).toEqual(payload.subarray(10, 20));
  });

  it("returns null rather than throwing for anything absent", async () => {
    const fs = zipFileSystem(fileOf("/a.zip", await makeZip([{ name: "a.txt", text: "a" }])));
    expect(await fs.file("/nope.txt")).toBeNull();
    expect(await fs.directory("/nope")).toBeNull();
    // A directory is not a file and a file is not a directory.
    expect(await fs.directory("/a.txt")).toBeNull();
  });

  it("says what is wrong when handed something that is not an archive", async () => {
    const fs = zipFileSystem(fileOf("/a.zip", new TextEncoder().encode("not a zip")));
    await expect(fs.file("/a.txt")).rejects.toThrow(/not a readable zip archive/);
  });

  it("can match names without regard to case, when asked", async () => {
    const zip = await makeZip([{ name: "MS43.IPO", text: "x" }]);
    expect(await zipFileSystem(fileOf("/a.zip", zip)).file("/ms43.ipo")).toBeNull();
    const insensitive = zipFileSystem(fileOf("/a.zip", zip), { caseInsensitive: true });
    expect(await insensitive.file("/ms43.ipo")).not.toBeNull();
  });

  it("answers with the entry name as stored, not as asked for", async () => {
    const zip = await makeZip([{ name: "SGDAT/MS43.IPO", text: "x" }]);
    const fs = zipFileSystem(fileOf("/a.zip", zip), { caseInsensitive: true });

    const file = await fs.file("/sgdat/ms43.ipo");
    expect(file!.name).toBe("MS43.IPO");
    expect(file!.path).toBe("/SGDAT/MS43.IPO");
    expect((await fs.directory("/sgdat"))!.path).toBe("/SGDAT");
  });

  it("agrees with itself about whether a folded path exists", async () => {
    // `stat` went through the parent's listing and matched by exact name, so it
    // said null for a path `file()` would happily read.
    const zip = await makeZip([{ name: "SGDAT/MS43.IPO", text: "xy" }]);
    const fs = zipFileSystem(fileOf("/a.zip", zip), { caseInsensitive: true });

    expect(await fs.stat("/sgdat/ms43.ipo")).toEqual({
      kind: "file",
      name: "MS43.IPO",
      size: 2,
    });
    expect(await fs.stat("/sgdat")).toEqual({ kind: "directory", name: "SGDAT", size: 0 });
    expect(await fs.stat("/nope")).toBeNull();
  });
});

describe("# addressing", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "csfs-"));
    const inner = await makeZip([{ name: "deep/file.txt", text: "from the inner zip" }]);
    const outer = await makeZip([
      { name: "inner.zip", bytes: inner },
      { name: "plain.txt", text: "beside it" },
    ]);
    await writeFile(join(dir, "outer.zip"), outer);
    await writeFile(join(dir, "loose.txt"), "on disk");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads through one archive", async () => {
    const fs = withArchives(nodeFileSystem(dir));
    expect(
      await fs.read("/outer.zip#/plain.txt").then((b) => new TextDecoder().decode(b!)),
    ).toBe("beside it");
  });

  it("reads through nested archives", async () => {
    // The reason nesting is supported at all: it costs one loop, and without
    // it someone eventually hits the special case.
    const fs = withArchives(nodeFileSystem(dir));
    const bytes = await fs.read("/outer.zip#/inner.zip#/deep/file.txt");
    expect(new TextDecoder().decode(bytes!)).toBe("from the inner zip");
  });

  it("leaves ordinary paths alone", async () => {
    const fs = withArchives(nodeFileSystem(dir));
    expect(new TextDecoder().decode((await fs.read("/loose.txt"))!)).toBe("on disk");
    expect(await fs.read("/absent.txt")).toBeNull();
  });

  it("lists a directory inside an archive", async () => {
    const fs = withArchives(nodeFileSystem(dir));
    const inside = await fs.directory("/outer.zip#/");
    expect((await inside!.entries()).map((e) => e.name).sort()).toEqual([
      "inner.zip",
      "plain.txt",
    ]);
  });

  it("answers with the full path, archive and all", async () => {
    const fs = withArchives(nodeFileSystem(dir));
    const file = await fs.file("/outer.zip#/inner.zip#/deep/file.txt");
    expect(file!.path).toBe("/outer.zip#/inner.zip#/deep/file.txt");
    expect(file!.name).toBe("file.txt");
    expect(file!.slice(0, 4).path).toBe(file!.path);
    const inside = await fs.directory("/outer.zip#/");
    expect(inside!.path).toBe("/outer.zip#/");
    expect((await inside!.file("plain.txt"))!.path).toBe("/outer.zip#/plain.txt");
    expect((await fs.directory("/outer.zip#/inner.zip#/deep"))!.path).toBe(
      "/outer.zip#/inner.zip#/deep",
    );
  });

  it("resolves .. without escaping the archive", async () => {
    // Paths arrive from manifests and URLs, so this is untrusted input.
    const fs = withArchives(nodeFileSystem(dir));
    expect(await fs.read("/outer.zip#/../../../etc/passwd")).toBeNull();
  });
});

describe("mounted archives", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "csfs-mount-"));
    // A flat archive standing in for a nested tree — the shape a parts
    // catalogue ships its drawings in.
    await writeFile(
      join(dir, "drawings.zip"),
      await makeZip([{ name: "1132C000.png", text: "a drawing" }]),
    );
    // Two archives serving one directory with no overlapping names, which is
    // how a multi-disc set ships its illustrations.
    await writeFile(
      join(dir, "img-1.zip"),
      await makeZip([{ name: "one.png", text: "first" }]),
    );
    await writeFile(
      join(dir, "img-2.zip"),
      await makeZip([{ name: "two.png", text: "second" }]),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves a flat archive under a nested path", async () => {
    const fs = withTransparentArchives(nodeFileSystem(dir), [
      { archive: "/drawings.zip", serves: "/drawings", entry: "basename" },
    ]);
    const bytes = await fs.read("/drawings/1132/1132C000.png");
    expect(new TextDecoder().decode(bytes!)).toBe("a drawing");
  });

  it("tries every archive that serves a directory", async () => {
    const fs = withTransparentArchives(nodeFileSystem(dir), [
      { archive: "/img-1.zip", serves: "/img", entry: "basename" },
      { archive: "/img-2.zip", serves: "/img", entry: "basename" },
    ]);
    expect(new TextDecoder().decode((await fs.read("/img/one.png"))!)).toBe("first");
    expect(new TextDecoder().decode((await fs.read("/img/two.png"))!)).toBe("second");
    expect(await fs.read("/img/three.png")).toBeNull();
  });

  it("prefers a real file, so an extracted tree keeps working", async () => {
    await writeFile(join(dir, "extracted.txt"), "the real one");
    const fs = withTransparentArchives(nodeFileSystem(dir), [
      { archive: "/drawings.zip", serves: "/", entry: "basename" },
    ]);
    expect(new TextDecoder().decode((await fs.read("/extracted.txt"))!)).toBe("the real one");
  });

  it("stats a file that exists only inside an archive", async () => {
    const fs = withTransparentArchives(nodeFileSystem(dir), [
      { archive: "/drawings.zip", serves: "/drawings", entry: "basename" },
    ]);
    const st = await fs.stat("/drawings/1132/1132C000.png");
    expect(st).toEqual({ kind: "file", name: "1132C000.png", size: 9 });
  });
});

describe("mounted archives, beyond the happy path", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "csfs-mount2-"));
    await writeFile(
      join(dir, "tree.zip"),
      await makeZip([
        { name: "Sub/Y.txt", text: "inside" },
        { name: "Foo.png", text: "archived" },
      ]),
    );
    await writeFile(join(dir, "foo.png"), "real");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const text = async (fs: CsFileSystem, path: string) =>
    (await fs.file(path).then((f) => f?.text())) ?? null;

  it("answers for the root when mounted at it", async () => {
    const fs = withTransparentArchives(nodeFileSystem(dir), [
      { archive: "/tree.zip", serves: "/" },
    ]);
    expect(await text(fs, "/Sub/Y.txt")).toBe("inside");
    expect((await fs.file("/Sub/Y.txt"))!.path).toBe("/Sub/Y.txt");
  });

  it("makes a mount's parents exist and list it", async () => {
    const fs = withTransparentArchives(nodeFileSystem(dir), [
      { archive: "/tree.zip", serves: "/a/b" },
    ]);
    expect(await text(fs, "/a/b/Sub/Y.txt")).toBe("inside");
    expect(await fs.directory("/a")).not.toBeNull();
    const root = await fs.directory("/");
    expect((await root!.entries()).find((e) => e.name === "a")).toEqual({
      kind: "directory",
      name: "a",
    });
    expect((await (await fs.directory("/a"))!.entries()).map((e) => e.name)).toEqual(["b"]);
    expect(await fs.stat("/a")).toEqual({ kind: "directory", name: "a", size: 0 });
  });

  it("makes a flat mount's directory exist", async () => {
    const fs = withTransparentArchives(nodeFileSystem(dir), [
      { archive: "/tree.zip", serves: "/flat", entry: "basename" },
    ]);
    expect(await fs.directory("/flat")).not.toBeNull();
  });

  it("reports where a mounted file is, as the archive stores it", async () => {
    const fs = withTransparentArchives(
      nodeFileSystem(dir),
      [{ archive: "/tree.zip", serves: "/Mnt" }],
      { caseInsensitive: true },
    );
    const file = await fs.file("/mnt/sub/y.txt");
    expect(file!.path).toBe("/Mnt/Sub/Y.txt");
    expect(await fs.stat("/mnt/sub/y.txt")).toEqual({ kind: "file", name: "Y.txt", size: 6 });
    expect((await fs.directory("/mnt/sub"))!.path).toBe("/Mnt/Sub");
  });

  it("stays exact about serves when not folding", async () => {
    const fs = withTransparentArchives(nodeFileSystem(dir), [
      { archive: "/tree.zip", serves: "/Mnt" },
    ]);
    expect(await fs.file("/mnt/Sub/Y.txt")).toBeNull();
  });

  it("serves one archive at two mounts, each in its own way", async () => {
    const fs = withTransparentArchives(nodeFileSystem(dir), [
      { archive: "/tree.zip", serves: "/flat", entry: "basename" },
      { archive: "/tree.zip", serves: "/tree" },
    ]);
    expect((await (await fs.directory("/tree"))!.entries()).map((e) => e.name).sort()).toEqual([
      "Foo.png",
      "Sub",
    ]);
    expect(await text(fs, "/flat/x/Foo.png")).toBe("archived");
  });

  it("lists a real and an archived name once when folding", async () => {
    const fs = withTransparentArchives(
      nodeFileSystem(dir),
      [{ archive: "/tree.zip", serves: "/" }],
      { caseInsensitive: true },
    );
    const names = (await (await fs.directory("/"))!.entries()).map((e) => e.name);
    expect(names.filter((n) => n.toLowerCase() === "foo.png")).toEqual(["foo.png"]);
  });

  it("stats an entry without inflating it", async () => {
    // Copied out of the Buffer, whose pooled backing store zip.js would see.
    const zip = new Uint8Array(await readFile(join(dir, "tree.zip")));
    let read = 0;
    const counting: CsFileSystem = {
      kind: "counting",
      async file(path) {
        if (path !== "/tree.zip") return null;
        return new RangeFile(path, zip.byteLength, async (a, b) => {
          read += b - a;
          return zip.subarray(a, b);
        });
      },
      async directory() {
        return null;
      },
      async read() {
        return null;
      },
      async stat() {
        return null;
      },
    };
    const fs = withTransparentArchives(counting, [{ archive: "/tree.zip", serves: "/" }]);
    await fs.stat("/Sub/Y.txt");
    const afterFirst = read;
    await fs.stat("/Foo.png");
    // The central directory is read once; a stat after that touches nothing.
    expect(read).toBe(afterFirst);
  });
});

describe("reading an entry", () => {
  it("inflates on the first read, not at lookup, and once for every slice", async () => {
    const zip = await makeZip([{ name: "big.bin", bytes: new Uint8Array(100_000).fill(7) }]);
    let read = 0;
    const archive = new RangeFile("/a.zip", zip.byteLength, async (s, e) => {
      read += e - s;
      return zip.subarray(s, e);
    });
    const fs = zipFileSystem(archive);
    const file = (await fs.file("/big.bin"))!;
    const afterLookup = read;
    expect(file.size).toBe(100_000);
    await file.slice(0, 10).bytes();
    const afterFirst = read;
    expect(afterFirst).toBeGreaterThan(afterLookup);
    await file.slice(50_000, 50_010).bytes();
    await file.bytes();
    expect(read).toBe(afterFirst);
  });

  it("stops inflating when the read is cancelled", async () => {
    const zip = await makeZip([{ name: "x.txt", text: "hello" }]);
    const fs = zipFileSystem(fileOf("/a.zip", zip));
    const file = (await fs.file("/x.txt"))!;
    await expect(file.text({ signal: AbortSignal.abort(new Error("no")) })).rejects.toThrow(
      "no",
    );
    expect(await file.text()).toBe("hello");
  });
});

describe("a stored entry", () => {
  /** An archive whose entries are stored, not deflated. */
  async function storedZip(files: { name: string; bytes: Uint8Array }[]) {
    const writer = new ZipWriter(new BlobWriter("application/zip"), {
      useWebWorkers: false,
      level: 0,
    });
    for (const f of files) await writer.add(f.name, new Uint8ArrayReader(f.bytes));
    return new Uint8Array(await (await writer.close()).arrayBuffer());
  }

  /** An archive file that counts the bytes read from it. */
  function counted(path: string, bytes: Uint8Array) {
    const counter = { read: 0 };
    const file = new RangeFile(path, bytes.byteLength, async (s, e) => {
      counter.read += e - s;
      return bytes.slice(s, e);
    });
    return { file, counter };
  }

  const big = new Uint8Array(200_000).map((_, i) => (i * 13) % 251);

  it("reads a slice by range from the archive, not the whole entry", async () => {
    const { file, counter } = counted(
      "/s.zip",
      await storedZip([{ name: "big.bin", bytes: big }]),
    );
    const entry = (await zipFileSystem(file).file("/big.bin"))!;
    const before = counter.read;
    expect(await entry.slice(150_000, 150_100).bytes()).toEqual(big.subarray(150_000, 150_100));
    // The local header, then the hundred bytes asked for.
    expect(counter.read - before).toBeLessThan(200);
    expect(await entry.bytes()).toEqual(big);
    expect(new Uint8Array(await new Response(entry.stream()).arrayBuffer())).toEqual(big);
  });

  it("reads an archive stored inside an archive without holding the outer entry", async () => {
    const inner = await storedZip([{ name: "deep.bin", bytes: big }]);
    const { file, counter } = counted(
      "/outer.zip",
      await storedZip([{ name: "inner.zip", bytes: inner }]),
    );
    const fs = withArchives({
      kind: "one",
      file: async (p) => (p === "/outer.zip" ? file : null),
      directory: async () => null,
      read: async () => null,
      stat: async () => null,
    });
    const deep = (await fs.file("/outer.zip#/inner.zip#/deep.bin"))!;
    // Opening costs zip.js's search for each archive's end record — up to
    // 64 KB apiece — and nothing like the 200 KB inside.
    expect(counter.read).toBeLessThan(big.byteLength);
    const opened = counter.read;
    expect(await deep.slice(10, 20).bytes()).toEqual(big.subarray(10, 20));
    // Then a read is its header and its bytes, straight through both archives.
    expect(counter.read - opened).toBeLessThan(200);
  });

  it("never reads the wrong bytes when the local header is not where it should be", async () => {
    const zip = await storedZip([{ name: "x.bin", bytes: big.subarray(0, 64) }]);
    const { file } = counted("/a.zip", zip);
    const entry = (await zipFileSystem(file).file("/x.bin"))!;
    // The local header's signature, broken after the central directory is read.
    zip[0] = 0;
    // Handed to zip.js, which may refuse it — but never answered from an
    // offset computed out of a header that is not one.
    const got = await entry.bytes().catch(() => null);
    if (got !== null) expect(got).toEqual(big.subarray(0, 64));
  });
});

describe("archives that fail to open", () => {
  const flaky = (bytes: Uint8Array, failures: { left: number; error: () => Error }) => {
    const fs: CsFileSystem = {
      kind: "flaky",
      async file(path): Promise<CsFile | null> {
        if (path !== "/a.zip") return null;
        return new RangeFile(path, bytes.byteLength, async (s, e) => {
          if (failures.left > 0) {
            failures.left -= 1;
            throw failures.error();
          }
          return bytes.subarray(s, e);
        });
      },
      async directory() {
        return null;
      },
      async read() {
        return null;
      },
      async stat() {
        return null;
      },
    };
    return fs;
  };

  it("tries again after a failure, rather than keeping it", async () => {
    const zip = await makeZip([{ name: "x.txt", text: "ok" }]);
    const failures = { left: 1, error: () => new BackendError("connection reset", "/a.zip") };
    const fs = withArchives(flaky(zip, failures));
    await expect(fs.file("/a.zip#/x.txt")).rejects.toThrow(/connection reset/);
    expect(await fs.file("/a.zip#/x.txt").then((f) => f?.text())).toBe("ok");

    failures.left = 1;
    const mounted = withTransparentArchives(flaky(zip, failures), [
      { archive: "/a.zip", serves: "/m" },
    ]);
    await expect(mounted.file("/m/x.txt")).rejects.toThrow(/connection reset/);
    expect(await mounted.file("/m/x.txt").then((f) => f?.text())).toBe("ok");
  });

  it("passes a store's own error through with its type", async () => {
    const zip = await makeZip([{ name: "x.txt", text: "ok" }]);
    const failures = { left: 1, error: () => new NotDataError("http://h/a.zip", "text/html") };
    const err = await withArchives(flaky(zip, failures))
      .file("/a.zip#/x.txt")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotDataError);
  });
});

/** Keep `openAsBlob` referenced: it is what makes the Node backend sliceable. */
void openAsBlob;
