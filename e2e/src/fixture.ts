/**
 * The tree the browser reads, built fresh for every run.
 *
 * Built with the real builder and real archives, as the parity suite does, so
 * what a tab reads is what a deployment would serve. Contents are generated,
 * never committed, and deterministic, so a test can recompute what it expects
 * inside the page rather than being handed it.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import { buildManifest, formatManifest, MANIFEST_FILE } from "@emdzej/csfs-manifest";
import { nodeFileSystem } from "@emdzej/csfs-node";

/** The byte pattern every generated file uses: byte `i` is `(i * 7) % 256`. */
export const pattern = (n: number): Uint8Array =>
  new Uint8Array(n).map((_, i) => (i * 7) % 256);

/** A 1×1 PNG, so an `<img>` has something it can actually decode. */
export const DOT_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function makeZip(
  files: { name: string; text?: string; bytes?: Uint8Array }[],
  level?: number,
): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter("application/zip"), {
    useWebWorkers: false,
    ...(level !== undefined ? { level } : {}),
  });
  for (const f of files) {
    await writer.add(
      f.name,
      f.bytes ? new Uint8ArrayReader(f.bytes) : new TextReader(f.text ?? ""),
    );
  }
  return new Uint8Array(await (await writer.close()).arrayBuffer());
}

export async function buildFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "csfs-e2e-"));
  await mkdir(join(dir, "deep", "nested"), { recursive: true });
  await mkdir(join(dir, "img"), { recursive: true });
  await mkdir(join(dir, "EDIABAS", "Ecu"), { recursive: true });
  await writeFile(join(dir, "top.txt"), "at the top");
  await writeFile(join(dir, "deep", "nested", "big.bin"), pattern(1_000_000));
  await writeFile(join(dir, "deep", "odd name #1 100%?.txt"), "oddly named");
  await writeFile(join(dir, "EDIABAS", "Ecu", "MS43.PRG"), "prg");
  await writeFile(join(dir, "img", "dot.png"), DOT_PNG);
  await writeFile(join(dir, "index.html"), "<p>a page that is data</p>");
  // A flat archive standing in for a tree bucketed by name, deflated.
  await writeFile(
    join(dir, "drawings.zip"),
    await makeZip([
      { name: "1132C000.png", bytes: DOT_PNG },
      { name: "1132C001.txt", text: "a drawing's notes" },
    ]),
  );
  // Stored, with an archive stored inside it: readable by range through both.
  const inner = await makeZip([{ name: "deep.bin", bytes: pattern(200_000) }], 0);
  await writeFile(
    join(dir, "stored.zip"),
    await makeZip([{ name: "inner.zip", bytes: inner }], 0),
  );

  const manifest = await buildManifest(nodeFileSystem(dir), {
    label: "e2e",
    archives: [{ archive: "/drawings.zip", serves: "/drawings", entry: "basename" }],
  });
  await writeFile(join(dir, MANIFEST_FILE), formatManifest(manifest));
  return dir;
}
