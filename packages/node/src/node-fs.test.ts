/**
 * The Node backend, which is also the reference implementation — so the things
 * worth testing here are the ones where `node:fs` disagrees with the shape the
 * interface promises.
 *
 * Symlinks are that. `readdir` does not follow them, so a symlink is neither
 * `isFile()` nor `isDirectory()`, and a listing that tests only those two drops
 * it. `stat` *does* follow, so `file()` could read a path that `entries()` had
 * never mentioned — and since `buildManifest` walks listings, a symlinked file
 * was absent from every manifest the CLI wrote.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walkFileSystem } from "@emdzej/csfs-core";
import { nodeFileSystem } from "./index.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "csfs-node-"));
  await writeFile(join(dir, "real.txt"), "twelve bytes");
  await mkdir(join(dir, "sub"), { recursive: true });
  await writeFile(join(dir, "sub", "inner.txt"), "inner");
  await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
  await symlink(join(dir, "sub"), join(dir, "linkdir"));
  await symlink(join(dir, "gone.txt"), join(dir, "broken.txt"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("symlinks", () => {
  it("lists a symlinked file, with the size of its target", async () => {
    const fs = nodeFileSystem(dir);
    const root = await fs.directory("/");
    const entries = new Map((await root!.entries()).map((e) => [e.name, e]));

    expect(entries.get("link.txt")).toEqual({ kind: "file", name: "link.txt", size: 12 });
    // A symlink to a directory is listed as the directory it points at, so a
    // walk descends it exactly as it would the real one.
    expect(entries.get("linkdir")).toEqual({ kind: "directory", name: "linkdir" });
  });

  it("lists a broken symlink rather than dropping it", async () => {
    // It is an entry. Reporting it lets a caller that reads it get the failure
    // at the point it can say which path was bad; dropping it makes the file
    // merely absent, which is indistinguishable from never having existed.
    const fs = nodeFileSystem(dir);
    const root = await fs.directory("/");
    const found = (await root!.entries()).find((e) => e.name === "broken.txt");
    expect(found).toEqual({ kind: "file", name: "broken.txt", size: 0 });
  });

  it("agrees between a listing and a read", async () => {
    // The bug: `entries()` omitted what `file()` could read, so a manifest
    // built by walking was missing files the tree could serve.
    const fs = nodeFileSystem(dir);
    const root = await fs.directory("/");
    for (const entry of await root!.entries()) {
      if (entry.kind !== "file" || entry.name === "broken.txt") continue;
      expect(await fs.file(`/${entry.name}`)).not.toBeNull();
    }
    expect(await fs.read("/link.txt")).toEqual(new TextEncoder().encode("twelve bytes"));
  });

  it("walks a symlinked file and a symlinked directory", async () => {
    const fs = nodeFileSystem(dir);
    const seen: string[] = [];
    for await (const entry of walkFileSystem(fs, "/")) seen.push(entry.path);
    expect(seen.sort()).toEqual([
      "/broken.txt",
      "/link.txt",
      "/linkdir/inner.txt",
      "/real.txt",
      "/sub/inner.txt",
    ]);
  });

  it("does not list a directory as a file, or the reverse", async () => {
    const fs = nodeFileSystem(dir);
    expect(await fs.file("/linkdir")).toBeNull();
    expect(await fs.directory("/link.txt")).toBeNull();
  });
});
