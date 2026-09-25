/** Archives in a tab: over HTTP by range, and from a file the user picked. */
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { expect, origins, test } from "./fixtures.js";

test("reads a flat archive mounted over a directory, and shows its image", async ({
  harness,
}) => {
  const { origin } = origins();
  const result = await harness.evaluate(async (base) => {
    const { http, zip, core } = window.csfs;
    const remote = http.httpFileSystem(`${base}/data`);
    const fs = zip.withTransparentArchives(zip.withArchives(remote), await remote.archives());
    const notes = await (await fs.file("/drawings/1132/1132C001.txt"))!.text();
    const png = (await fs.file("/drawings/1132/1132C000.png"))!;
    const img = new Image();
    img.src = await core.objectUrl(png);
    await img.decode();
    URL.revokeObjectURL(img.src);
    return {
      notes,
      width: img.naturalWidth,
      type: png.type,
      direct: (await fs.directUrl?.(png.path)) ?? null,
    };
  }, origin);
  expect(result).toEqual({
    notes: "a drawing's notes",
    width: 1,
    type: "image/png",
    // Inside an archive, so no URL addresses it.
    direct: null,
  });
});

test("reads an archive stored inside an archive by small ranges", async ({ harness }) => {
  const { origin } = origins();
  const sizes: number[] = [];
  harness.on("response", async (r) => {
    if (r.url().includes("stored.zip")) sizes.push(Number(r.headers()["content-length"] ?? -1));
  });
  const ok = await harness.evaluate(async (base) => {
    const { http, zip } = window.csfs;
    const fs = zip.withArchives(http.httpFileSystem(`${base}/data`));
    const deep = (await fs.file("/stored.zip#/inner.zip#/deep.bin"))!;
    const bytes = await deep.slice(150_000, 150_010).bytes();
    return bytes.every((b, i) => b === ((150_000 + i) * 7) % 256);
  }, origin);
  expect(ok).toBe(true);
  // Nothing close to the 200 KB entry was ever fetched in one response.
  expect(Math.max(...sizes)).toBeLessThan(100_000);
});

test("opens a zip chosen with <input type=file>, with no adapter", async ({ harness }) => {
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  await writer.add("inside/hello.txt", new TextReader("picked"));
  const dir = await mkdtemp(join(tmpdir(), "csfs-e2e-pick-"));
  const path = join(dir, "picked.zip");
  await writeFile(path, new Uint8Array(await (await writer.close()).arrayBuffer()));

  await harness.setInputFiles("#pick", path);
  const result = await harness.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>("#pick")!;
    const fs = window.csfs.zip.zipFromBlob(input.files![0]!);
    const dir = await fs.directory("/inside");
    return {
      names: (await dir!.entries()).map((e) => e.name),
      text: await (await fs.file("/inside/hello.txt"))!.text(),
    };
  });
  expect(result).toEqual({ names: ["hello.txt"], text: "picked" });
});
