/**
 * The shared pieces every backend leans on: paths, `RangeFile`'s arithmetic,
 * and `walk`. Each was only covered indirectly, through a backend that might
 * have compensated for a mistake here.
 */
import { describe, expect, it } from "vitest";
import {
  RangeFile,
  basename,
  bytesFile,
  dirname,
  formatPath,
  normalizePath,
  parsePath,
  walkFileSystem,
  type CsDirectory,
  type CsFileSystem,
} from "./index.js";

describe("paths", () => {
  it.each([
    ["", "/"],
    ["a/b", "/a/b"],
    ["/a//b/", "/a/b"],
    ["/a/./b", "/a/b"],
    ["/a/../../etc", "/etc"],
    ["../../..", "/"],
  ])("normalises %j to %j", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it("splits and rebuilds an archive path", () => {
    const parsed = parsePath("/outer.zip#inner.zip#/deep/../file.txt");
    expect(parsed).toEqual({ base: "/outer.zip", fragments: ["/inner.zip", "/file.txt"] });
    expect(formatPath(parsed)).toBe("/outer.zip#/inner.zip#/file.txt");
  });

  it("names the root and its children", () => {
    expect(basename("/")).toBe("");
    expect(dirname("/")).toBe("/");
    expect(dirname("/a")).toBe("/");
    expect(basename("/a/b.txt")).toBe("b.txt");
  });
});

describe("RangeFile", () => {
  const data = new Uint8Array(100).map((_, i) => i);
  const reads: [number, number][] = [];
  const file = new RangeFile("/f.bin", data.byteLength, async (s, e) => {
    reads.push([s, e]);
    return data.slice(s, e);
  });

  it("slices as a Blob does", async () => {
    const blob = new Blob([data]);
    for (const [a, b] of [
      [0, 10],
      [-10, undefined],
      [-200, 5],
      [90, 200],
      [50, 40],
      [NaN, 3],
      [1.9, 4.2],
      [undefined, undefined],
    ] as const) {
      const ours = await file.slice(a, b).bytes();
      const theirs = new Uint8Array(await blob.slice(a, b).arrayBuffer());
      expect(ours, `slice(${a}, ${b})`).toEqual(theirs);
    }
  });

  it("composes slices by arithmetic, reading once", async () => {
    reads.length = 0;
    const inner = file.slice(10, 90).slice(5, 50).slice(-10);
    expect(inner.size).toBe(10);
    expect(reads).toEqual([]);
    expect(await inner.bytes()).toEqual(data.slice(50, 60));
    expect(reads).toEqual([[50, 60]]);
  });

  it("hands out a buffer the caller owns", async () => {
    const f = bytesFile("/b", new Uint8Array([1, 2, 3]));
    new Uint8Array(await f.arrayBuffer())[0] = 9;
    expect((await f.bytes())[0]).toBe(1);
  });
});

describe("walkFileSystem", () => {
  /** A tree from a map of path to children. */
  function tree(shape: Record<string, string[]>): CsFileSystem {
    const dir = (path: string): CsDirectory | null => {
      const children = shape[path];
      if (!children) return null;
      return {
        path,
        name: basename(path),
        async entries() {
          return children.map((name) => {
            const child = path === "/" ? `/${name}` : `${path}/${name}`;
            return shape[child]
              ? { kind: "directory" as const, name }
              : { kind: "file" as const, name, size: 1 };
          });
        },
        async file() {
          return null;
        },
        async directory(name) {
          return dir(path === "/" ? `/${name}` : `${path}/${name}`);
        },
      };
    };
    return {
      kind: "tree",
      async file() {
        return null;
      },
      async directory(path) {
        return dir(normalizePath(path));
      },
      async read() {
        return null;
      },
      async stat() {
        return null;
      },
    };
  }

  const fs = tree({ "/": ["a", "top.txt"], "/a": ["b", "x.txt"], "/a/b": ["y.txt"] });

  it("yields rooted paths, depth-first", async () => {
    const paths: string[] = [];
    for await (const e of walkFileSystem(fs)) paths.push(e.path);
    expect(paths).toEqual(["/a/b/y.txt", "/a/x.txt", "/top.txt"]);
  });

  it("yields rooted paths from an unrooted start", async () => {
    const paths: string[] = [];
    for await (const e of walkFileSystem(fs, "a/")) paths.push(e.path);
    expect(paths).toEqual(["/a/b/y.txt", "/a/x.txt"]);
  });

  it("prunes a directory its filter rejects", async () => {
    const paths: string[] = [];
    const filter = (e: { path: string }) => e.path !== "/a/b";
    for await (const e of walkFileSystem(fs, "/", { filter })) paths.push(e.path);
    expect(paths).toEqual(["/a/x.txt", "/top.txt"]);
  });
});
