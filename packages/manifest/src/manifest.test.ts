/**
 * The manifest, and the index built from it.
 *
 * `prune` is the part worth testing directly: it is the difference between not
 * describing a subtree and not *walking* it, and only the second one is
 * affordable on a tree where the ignored part is the big part.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodeFileSystem } from "@emdzej/csfs-node";
import { buildManifest, formatManifest, ManifestIndex, type Manifest } from "./index.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csfs-manifest-"));
  await writeFile(join(dir, "keep.txt"), "a");
  await mkdir(join(dir, "skipme", "deep"), { recursive: true });
  await writeFile(join(dir, "skipme", "one.tmp"), "b");
  await writeFile(join(dir, "skipme", "deep", "two.tmp"), "cc");
  await mkdir(join(dir, "data"), { recursive: true });
  await writeFile(join(dir, "data", "three.bin"), "ddd");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildManifest", () => {
  it("describes every file, with its size", async () => {
    const manifest = await buildManifest(nodeFileSystem(dir));
    expect(manifest.files).toEqual({
      "/keep.txt": 1,
      "/skipme/one.tmp": 1,
      "/skipme/deep/two.tmp": 2,
      "/data/three.bin": 3,
    });
  });

  it("prunes a subtree without walking into it", async () => {
    // `filter` is asked about each file *after* the walk found it, so filtering
    // a 200,000-file subtree still costs the walk. `prune` is asked before
    // descending — which is what an ignore pattern actually wants.
    const visited: string[] = [];
    const manifest = await buildManifest(nodeFileSystem(dir), {
      prune: (path) => {
        visited.push(path);
        return path === "/skipme";
      },
    });
    expect(Object.keys(manifest.files).sort()).toEqual(["/data/three.bin", "/keep.txt"]);
    // `/skipme/deep` was never even offered, which is the point.
    expect(visited).not.toContain("/skipme/deep");
  });

  it("still filters individual files", async () => {
    const manifest = await buildManifest(nodeFileSystem(dir), {
      filter: (path) => !path.endsWith(".tmp"),
    });
    expect(Object.keys(manifest.files).sort()).toEqual(["/data/three.bin", "/keep.txt"]);
  });

  it("omits builtAt and label rather than inventing them", async () => {
    const manifest = await buildManifest(nodeFileSystem(dir));
    expect("builtAt" in manifest).toBe(false);
    expect("label" in manifest).toBe(false);
  });

  it("serialises reproducibly, whatever order the map came in", async () => {
    const a: Manifest = { csfs: 1, files: { "/b": 2, "/a": 1 } };
    const b: Manifest = { csfs: 1, files: { "/a": 1, "/b": 2 } };
    expect(formatManifest(a)).toBe(formatManifest(b));
  });
});

describe("ManifestIndex, case-insensitively", () => {
  const manifest: Manifest = {
    csfs: 1,
    files: { "/EDIABAS/Ecu/MS43.PRG": 12, "/EC-APPS/INPA/startus.ipo": 7 },
  };

  it("resolves to the path the manifest records", () => {
    const index = new ManifestIndex(manifest, { caseInsensitive: true });
    expect(index.canonical("/ediabas/ecu/ms43.prg")).toBe("/EDIABAS/Ecu/MS43.PRG");
    expect(index.canonical("/EDIABAS/ECU")).toBe("/EDIABAS/Ecu");
    expect(index.canonical("/nope")).toBeNull();
    expect(index.size("/ediabas/ecu/ms43.prg")).toBe(12);
    expect(index.hasDirectory("/ec-apps/inpa")).toBe(true);
  });

  it("is the identity when not folding", () => {
    const index = new ManifestIndex(manifest);
    expect(index.canonical("/EDIABAS/Ecu/MS43.PRG")).toBe("/EDIABAS/Ecu/MS43.PRG");
    expect(index.canonical("/ediabas/ecu/ms43.prg")).toBeNull();
    expect(index.caseCollisions).toEqual([]);
  });

  it("picks the same winner however the file map is ordered", () => {
    // A manifest rebuilt from the same tree must resolve identically to the one
    // it replaced. JSON key order is not a property of the tree, so sorting is
    // what makes the choice reproducible.
    const forward: Manifest = { csfs: 1, files: { "/x/A.BIN": 1, "/x/a.bin": 2 } };
    const reverse: Manifest = { csfs: 1, files: { "/x/a.bin": 2, "/x/A.BIN": 1 } };
    for (const m of [forward, reverse]) {
      const index = new ManifestIndex(m, { caseInsensitive: true });
      expect(index.canonical("/X/a.BIN")).toBe("/x/A.BIN");
      expect(index.caseCollisions).toEqual([["/x/A.BIN", "/x/a.bin"]]);
    }
  });

  it("lets an exact spelling reach a file the fold would shadow", () => {
    const m: Manifest = { csfs: 1, files: { "/x/A.BIN": 1, "/x/a.bin": 2 } };
    const index = new ManifestIndex(m, { caseInsensitive: true });
    expect(index.size("/x/a.bin")).toBe(2);
    expect(index.size("/x/A.BIN")).toBe(1);
  });

  it("folds a directory an archive stands in for", () => {
    // Those directories exist only because an archive says it serves them, so
    // they have to be in the fold as well as in the listing.
    const m: Manifest = {
      csfs: 1,
      files: { "/Drawings.zip": 100 },
      archives: [{ archive: "/Drawings.zip", serves: "/Drawings", entry: "basename" }],
    };
    const index = new ManifestIndex(m, { caseInsensitive: true });
    expect(index.hasDirectory("/drawings")).toBe(true);
    expect(index.canonical("/drawings")).toBe("/Drawings");
  });
});
