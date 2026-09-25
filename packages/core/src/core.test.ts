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
  shared,
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

describe("shared", () => {
  /** Work that finishes when told to, and reports whether it was cancelled. */
  function work() {
    let finish!: (v: string) => void;
    const state = { starts: 0, cancelled: false };
    const task = shared((signal) => {
      state.starts += 1;
      signal.addEventListener("abort", () => (state.cancelled = true));
      return new Promise<string>((resolve) => (finish = resolve));
    });
    return { task, state, finish: (v: string) => finish(v) };
  }

  it("keeps going for the readers who stayed", async () => {
    const { task, state, finish } = work();
    const leaving = new AbortController();
    const a = task(leaving.signal);
    const b = task(new AbortController().signal);
    leaving.abort(new Error("left"));
    await expect(a).rejects.toThrow("left");
    finish("done");
    expect(await b).toBe("done");
    expect(state).toEqual({ starts: 1, cancelled: false });
  });

  it("stops when every reader has left, and starts again for the next", async () => {
    const { task, state } = work();
    const one = new AbortController();
    const two = new AbortController();
    const a = task(one.signal);
    const b = task(two.signal);
    one.abort();
    two.abort();
    await expect(a).rejects.toBeDefined();
    await expect(b).rejects.toBeDefined();
    expect(state.cancelled).toBe(true);
    void task(new AbortController().signal);
    expect(state.starts).toBe(2);
  });

  it("is never cancelled while a reader without a signal waits", async () => {
    const { task, state, finish } = work();
    const leaving = new AbortController();
    const pinned = task();
    const a = task(leaving.signal);
    leaving.abort();
    await expect(a).rejects.toBeDefined();
    finish("done");
    expect(await pinned).toBe("done");
    expect(state.cancelled).toBe(false);
  });
});

describe("reading with a signal", () => {
  it("does not start a read already aborted", async () => {
    let reads = 0;
    const file = new RangeFile("/f", 10, async () => {
      reads += 1;
      return new Uint8Array(10);
    });
    const signal = AbortSignal.abort(new Error("no"));
    await expect(file.bytes({ signal })).rejects.toThrow("no");
    await expect(bytesFile("/b", new Uint8Array(1)).text({ signal })).rejects.toThrow("no");
    expect(reads).toBe(0);
  });

  it("hands the signal to the reader", async () => {
    let seen: AbortSignal | undefined;
    const file = new RangeFile("/f", 10, async (_s, _e, signal) => {
      seen = signal;
      return new Uint8Array(4);
    });
    const controller = new AbortController();
    await file.slice(2, 6).bytes({ signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});
