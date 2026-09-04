import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import { zipFromBlob } from "./zip-fs.js";
import { withArchives } from "./archives.js";

async function makeZip(files: { name: string; text?: string; bytes?: Uint8Array }[]) {
  const w = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  for (const f of files) {
    await w.add(f.name, f.bytes ? new Uint8ArrayReader(f.bytes) : new TextReader(f.text ?? ""));
  }
  return new Uint8Array(await (await w.close()).arrayBuffer());
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csfs-blob-"));
  const inner = await makeZip([{ name: "buried.txt", text: "two levels down" }]);
  await writeFile(
    join(dir, "outer.zip"),
    await makeZip([
      { name: "top.txt", text: "at the top" },
      { name: "deep/leaf.txt", text: "a leaf" },
      { name: "inner.zip", bytes: inner },
    ]),
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Exactly what a picker, an `<input type="file">` or a drop event hands over. */
async function pickedFile(): Promise<File> {
  const bytes = await readFile(join(dir, "outer.zip"));
  return new File([bytes as unknown as BlobPart], "outer.zip", { type: "application/zip" });
}

describe("a picked archive as a file system", () => {
  it("mounts a File with no adapter, because a File is a Blob", async () => {
    // The claim the whole contract rests on. If this needed an adapter, the
    // interface would be wrong.
    const fs = zipFromBlob(await pickedFile());
    expect(fs.kind).toBe("zip");
    const root = await fs.directory("/");
    expect((await root!.entries()).map((e) => `${e.kind}:${e.name}`).sort()).toEqual([
      "directory:deep",
      "file:inner.zip",
      "file:top.txt",
    ]);
    expect(await (await fs.file("/top.txt"))!.text()).toBe("at the top");
    expect(await (await fs.file("/deep/leaf.txt"))!.text()).toBe("a leaf");
  });

  it("takes its path from the file's own name", async () => {
    const fs = zipFromBlob(await pickedFile());
    const file = await fs.file("/top.txt");
    expect(file!.path).toBe("/top.txt");
    expect(file!.type).toBe("text/plain; charset=utf-8");
  });

  it("reads an archive nested inside the picked one", async () => {
    // Composition worth checking rather than assuming: the outer entry is
    // decompressed to bytes, and those bytes then have to serve as a
    // container in their own right.
    const fs = withArchives(zipFromBlob(await pickedFile()));
    const bytes = await fs.read("/inner.zip#/buried.txt");
    expect(new TextDecoder().decode(bytes!)).toBe("two levels down");
  });

  it("reports absence as null, from a blob as from anywhere else", async () => {
    const fs = zipFromBlob(await pickedFile());
    expect(await fs.file("/nope.txt")).toBeNull();
    expect(await fs.directory("/nope")).toBeNull();
    expect(await fs.stat("/nope")).toBeNull();
  });

  it("says what is wrong when the file is not an archive", async () => {
    const notAZip = new File(
      [new TextEncoder().encode("hello") as unknown as BlobPart],
      "x.zip",
    );
    const fs = zipFromBlob(notAZip);
    await expect(fs.file("/anything")).rejects.toThrow(/not a readable zip archive/);
  });
});
