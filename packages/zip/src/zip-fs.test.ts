import { openAsBlob } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BlobFile, type BlobLike } from "@emdzej/csfs-core";
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

/** Keep `openAsBlob` referenced: it is what makes the Node backend sliceable. */
void openAsBlob;
