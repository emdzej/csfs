/**
 * The handle-backed backends, read against `node` byte for byte.
 *
 * `http/src/parity.test.ts` holds the same line for HTTP; this is the half that
 * was missing. `fsa` and `opfs` had tests of their own name resolution and
 * nothing that compared what they *read* with anything — and a backend's own
 * suite only proves it is self-consistent.
 *
 * The tree is written through `fsa`'s own `write`, into the in-memory fake, from
 * a real directory, so the copy is part of what is being checked. `opfs` is the
 * same backend over a root `navigator.storage` hands out, so it is opened
 * through `opfsFileSystem` against a stubbed `navigator` and read the same way.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import { walkFileSystem, type CsFileSystem, type WritableFileSystem } from "@emdzej/csfs-core";
import { nodeFileSystem } from "@emdzej/csfs-node";
import { opfsFileSystem } from "@emdzej/csfs-opfs";
import { withArchives } from "@emdzej/csfs-zip";
import { fakeDirectory } from "./fake-directory.js";
import { fsaFileSystem } from "./index.js";

const pattern = (n: number) => new Uint8Array(n).map((_, i) => (i * 7) % 256);

let dir: string;

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

/** Copy every file of one tree into another, through the target's `write`. */
async function copy(from: CsFileSystem, to: WritableFileSystem): Promise<void> {
  for await (const e of walkFileSystem(from)) {
    await to.write(e.path, (await from.read(e.path))!);
  }
}

/** Every file's path and true size — asked of the file, since a listing may say 0. */
async function inventory(fs: CsFileSystem): Promise<string[]> {
  const out: string[] = [];
  for await (const e of walkFileSystem(fs))
    out.push(`${e.path} ${(await fs.file(e.path))!.size}`);
  return out.sort();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csfs-fsa-parity-"));
  await mkdir(join(dir, "deep", "nested"), { recursive: true });
  await writeFile(join(dir, "top.txt"), "at the top");
  await writeFile(join(dir, "deep", "nested", "big.bin"), pattern(300_000));
  await writeFile(join(dir, "deep", "Mixed.Case"), "stored as typed");
  await writeFile(
    join(dir, "pack.zip"),
    await makeZip([
      { name: "inside/a.txt", text: "from the archive" },
      { name: "b.bin", bytes: pattern(4096) },
    ]),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const backends: [string, () => Promise<WritableFileSystem>][] = [
  ["fsa", async () => fsaFileSystem(fakeDirectory())],
  [
    "opfs",
    async () => {
      const root = fakeDirectory("opfs-root");
      const storage = { getDirectory: async () => root };
      Object.defineProperty(globalThis, "navigator", {
        value: { storage },
        configurable: true,
      });
      try {
        return await opfsFileSystem({ namespace: "parity" });
      } finally {
        Reflect.deleteProperty(globalThis, "navigator");
      }
    },
  ],
];

describe.each(backends)("%s and node agree", (kind, make) => {
  let local: CsFileSystem;
  let handles: WritableFileSystem;

  beforeAll(async () => {
    local = nodeFileSystem(dir);
    handles = await make();
    await copy(local, handles);
  });

  it("reports its own kind", () => {
    expect(handles.kind).toBe(kind);
  });

  it("walks to the same files and sizes", async () => {
    expect(await inventory(handles)).toEqual(await inventory(local));
  });

  it("returns identical bytes for a range, at several offsets", async () => {
    const a = (await local.file("/deep/nested/big.bin"))!;
    const b = (await handles.file("/deep/nested/big.bin"))!;
    for (const [start, end] of [
      [0, 1],
      [1, 2],
      [12345, 12346],
      [299_999, 300_000],
      [250_000, 400_000],
      [-10, undefined],
    ] as const) {
      expect(await b.slice(start, end).bytes()).toEqual(await a.slice(start, end).bytes());
    }
  });

  it("reads inside an archive the same way", async () => {
    for (const path of ["/pack.zip#/inside/a.txt", "/pack.zip#/b.bin"]) {
      const a = await withArchives(local).read(path);
      const b = await withArchives(handles).read(path);
      expect(b).toEqual(a);
    }
  });

  it("stats the same, and names the root the same", async () => {
    for (const path of ["/", "/top.txt", "/deep", "/deep/Mixed.Case", "/absent"]) {
      expect(await handles.stat(path), path).toEqual(await local.stat(path));
    }
  });
});
