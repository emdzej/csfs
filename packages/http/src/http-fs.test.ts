import { describe, expect, it } from "vitest";
import { NotDataError, RangeUnsupportedError } from "@emdzej/csfs-core";
import type { Manifest } from "@emdzej/csfs-manifest";
import { httpFileSystem } from "./index.js";

const MANIFEST: Manifest = {
  csfs: 1,
  files: {
    "/a.txt": 5,
    "/deep/nested/b.bin": 256,
    "/only.zip": 100,
  },
  archives: [{ archive: "/only.zip", serves: "/mounted", entry: "basename" }],
};

/**
 * A fetch that serves the manifest and honours `Range` over a byte pattern.
 *
 * Range handling is modelled rather than faked because it is the thing worth
 * testing: a backend that quietly ignores an offset would pass any test that
 * only checked lengths.
 */
function serving(
  bodies: Record<string, Uint8Array>,
  opts: { ignoreRange?: boolean; html?: boolean } = {},
) {
  const calls: { url: string; range?: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    calls.push({ url, ...(range !== undefined ? { range } : {}) });

    if (opts.html) {
      return new Response("<!doctype html><title>404</title>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.endsWith("/csfs-manifest.json")) {
      return new Response(JSON.stringify(MANIFEST), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const path = new URL(url, "http://x").pathname;
    const body = bodies[path];
    if (!body) return new Response("nope", { status: 404 });

    if (!range || opts.ignoreRange) {
      // What a host without Range support does: 200 and the whole body.
      return new Response(body as unknown as BodyInit, { status: 200 });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(m[1]);
    const end = Number(m[2]) + 1;
    return new Response(body.subarray(start, end) as unknown as BodyInit, {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end - 1}/${body.byteLength}` },
    });
  }) as typeof globalThis.fetch;
  return { impl, calls };
}

const pattern = (n: number) => new Uint8Array(n).map((_, i) => i % 256);

describe("HttpFileSystem", () => {
  it("lists directories from the manifest, since HTTP cannot", async () => {
    const { impl } = serving({});
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    const root = await fs.directory("/");
    expect((await root!.entries()).map((e) => `${e.kind}:${e.name}`).sort()).toEqual([
      "directory:deep",
      "directory:mounted",
      "file:a.txt",
      "file:only.zip",
    ]);
    // Directories are derived from file paths, and `mounted` exists only
    // because an archive says it serves it.
    expect(await fs.directory("/deep/nested")).not.toBeNull();
    expect(await fs.directory("/absent")).toBeNull();
  });

  it("reads a byte range, and reads the right bytes", async () => {
    const body = pattern(256);
    const { impl, calls } = serving({ "/data/deep/nested/b.bin": body });
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    const file = await fs.file("/deep/nested/b.bin");
    expect(file!.size).toBe(256);
    expect(await file!.slice(10, 20).bytes()).toEqual(body.subarray(10, 20));
    // Slicing a slice composes by arithmetic, and costs nothing until read.
    expect(await file!.slice(10, 30).slice(5, 10).bytes()).toEqual(body.subarray(15, 20));
    expect(calls.filter((c) => c.range).map((c) => c.range)).toEqual([
      "bytes=10-19",
      "bytes=15-19",
    ]);
  });

  it("slices locally when a host ignores Range, and stops asking", async () => {
    // The body of a 200 is the *whole* file, so passing it through as the
    // requested slice would yield wrong data with no error. Slicing it here is
    // the other way to be right about it, and it is the one that leaves the
    // tree readable on a host with no Range support at all.
    const body = pattern(5);
    const { impl, calls } = serving({ "/data/a.txt": body }, { ignoreRange: true });
    // The kept body is disabled here so the second read has to go to the
    // network — otherwise it is served locally and says nothing about whether
    // the header would have been sent again.
    const fs = httpFileSystem("http://host/data", { fetch: impl, wholeFileCacheBytes: 0 });
    const file = await fs.file("/a.txt");
    expect(fs.rangesSupported).toBeUndefined();

    expect(await file!.slice(1, 3).bytes()).toEqual(body.subarray(1, 3));
    expect(fs.rangesSupported).toBe(false);

    // The probe is worth one round trip, not one per read: having learnt that
    // the host ignores the header, it is not sent again.
    expect(await file!.slice(3, 5).bytes()).toEqual(body.subarray(3, 5));
    const reads = calls.filter((c) => !c.url.endsWith("csfs-manifest.json"));
    expect(reads.map((c) => c.range)).toEqual(["bytes=1-2", undefined]);
  });

  it("serves later slices of the same file from the one body it kept", async () => {
    // A single archive read is several slices of one file — its end, then its
    // central directory, then an entry. Without this a no-Range host would
    // serve the whole archive once per slice.
    // `b.bin`, not `a.txt`: the manifest declares a.txt as 5 bytes, and
    // `slice` clamps to the declared size before any of this is reached.
    const body = pattern(256);
    const { impl, calls } = serving({ "/data/deep/nested/b.bin": body }, { ignoreRange: true });
    const fs = httpFileSystem("http://host/data", { fetch: impl, ranges: "never" });
    const file = await fs.file("/deep/nested/b.bin");
    expect(await file!.slice(0, 4).bytes()).toEqual(body.subarray(0, 4));
    expect(await file!.slice(250, 256).bytes()).toEqual(body.subarray(250, 256));
    expect(await file!.slice(8, 9).bytes()).toEqual(body.subarray(8, 9));
    expect(calls.filter((c) => c.url.endsWith("/b.bin"))).toHaveLength(1);
  });

  it("refetches rather than keeping a body over the cache limit", async () => {
    const body = pattern(256);
    const { impl, calls } = serving({ "/data/deep/nested/b.bin": body }, { ignoreRange: true });
    const fs = httpFileSystem("http://host/data", {
      fetch: impl,
      ranges: "never",
      wholeFileCacheBytes: 8,
    });
    const file = await fs.file("/deep/nested/b.bin");
    expect(await file!.slice(0, 4).bytes()).toEqual(body.subarray(0, 4));
    expect(await file!.slice(4, 8).bytes()).toEqual(body.subarray(4, 8));
    expect(calls.filter((c) => c.url.endsWith("/b.bin"))).toHaveLength(2);
  });

  it("never sends a Range header at all when told not to", async () => {
    const { impl, calls } = serving({ "/data/a.txt": pattern(5) }, { ignoreRange: true });
    const fs = httpFileSystem("http://host/data", { fetch: impl, ranges: "never" });
    expect(fs.rangesSupported).toBe(false);
    await (await fs.file("/a.txt"))!.bytes();
    expect(calls.every((c) => c.range === undefined)).toBe(true);
  });

  it("refuses a host that ignores Range when told to require it", async () => {
    // For a consumer that would rather fail than download 945 MB to read 64 KB.
    const { impl } = serving({ "/data/a.txt": pattern(5) }, { ignoreRange: true });
    const fs = httpFileSystem("http://host/data", { fetch: impl, ranges: "require" });
    const file = await fs.file("/a.txt");
    await expect(file!.slice(1, 3).bytes()).rejects.toThrow(RangeUnsupportedError);
  });

  it("rejects a web page served where data was expected", async () => {
    // A single-page app answers any unknown path with its own HTML and a 200,
    // so a mistyped base URL otherwise looks like a working tree.
    const { impl } = serving({}, { html: true });
    const fs = httpFileSystem("http://host/wrong", { fetch: impl });
    await expect(fs.file("/a.txt")).rejects.toThrow(NotDataError);
  });

  it("fetches the manifest once", async () => {
    const { impl, calls } = serving({ "/data/a.txt": pattern(5) });
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    await fs.file("/a.txt");
    await fs.directory("/");
    await fs.stat("/a.txt");
    expect(calls.filter((c) => c.url.endsWith("csfs-manifest.json"))).toHaveLength(1);
  });

  it("accepts a manifest supplied up front, and then fetches nothing to open", async () => {
    // For a consumer that bundled or cached it: opening a tree should be free.
    const { impl, calls } = serving({ "/data/a.txt": pattern(5) });
    const fs = httpFileSystem("http://host/data", { fetch: impl, manifest: MANIFEST });
    expect(await fs.stat("/a.txt")).toEqual({ kind: "file", name: "a.txt", size: 5 });
    expect(calls).toHaveLength(0);
  });

  it("gives a direct URL only for a file it knows about", async () => {
    // Returning a URL for anything asked would make this useless as an
    // existence test, and a caller wanting to fall back to an archive would
    // hold a URL that 404s — an `<img>` that never loads, with no error.
    const { impl } = serving({});
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    expect(await fs.directUrl("/a.txt")).toBe("http://host/data/a.txt");
    expect(await fs.directUrl("/absent.txt")).toBeNull();
  });

  it("reports absence as null, not as an error", async () => {
    const { impl } = serving({});
    const fs = httpFileSystem("http://host/data", { fetch: impl });
    expect(await fs.file("/absent")).toBeNull();
    expect(await fs.stat("/absent")).toBeNull();
    expect(await fs.read("/absent")).toBeNull();
  });
});

/**
 * A tree whose casing is inconsistent, which is what a BMW install rsynced off
 * Windows onto a Linux host actually looks like.
 */
const MIXED: Manifest = {
  csfs: 1,
  files: {
    "/EDIABAS/Ecu/MS43.PRG": 12,
    "/EC-APPS/INPA/CFGDAT/startus.ipo": 7,
  },
};

describe("HttpFileSystem, case-insensitively", () => {
  const open = (manifest: Manifest = MIXED) => {
    const { impl, calls } = serving({ "/data/EDIABAS/Ecu/MS43.PRG": pattern(12) });
    return {
      fs: httpFileSystem("http://host/data", {
        fetch: impl,
        manifest,
        caseInsensitive: true,
      }),
      calls,
    };
  };

  it("resolves a file whatever case it is asked for", async () => {
    const { fs } = open();
    for (const asked of [
      "/EDIABAS/Ecu/MS43.PRG",
      "/ediabas/ecu/ms43.prg",
      "/EDIABAS/ECU/Ms43.Prg",
    ]) {
      expect((await fs.file(asked))?.size).toBe(12);
    }
    expect(await fs.file("/ediabas/ecu/nope.prg")).toBeNull();
  });

  it("answers with the name the manifest records, not the one asked for", async () => {
    // The whole reason this matters: the name is handed on to ediabasx, which
    // pins a variant by it. Echoing back `ms43.prg` is a wrong answer that
    // looks like a right one.
    const { fs } = open();
    const file = await fs.file("/ediabas/ecu/ms43.prg");
    expect(file!.name).toBe("MS43.PRG");
    expect(file!.path).toBe("/EDIABAS/Ecu/MS43.PRG");
    expect(await fs.stat("/ediabas/ecu/ms43.prg")).toEqual({
      kind: "file",
      name: "MS43.PRG",
      size: 12,
    });
  });

  it("fetches the canonical URL, not the one asked for", async () => {
    const { fs, calls } = open();
    await fs.read("/ediabas/ecu/ms43.prg");
    expect(calls.map((c) => c.url)).toEqual(["http://host/data/EDIABAS/Ecu/MS43.PRG"]);
    expect(await fs.directUrl("/ediabas/ecu/ms43.prg")).toBe(
      "http://host/data/EDIABAS/Ecu/MS43.PRG",
    );
  });

  it("resolves and lists a directory whatever case it is asked for", async () => {
    const { fs } = open();
    const dir = await fs.directory("/ediabas/ecu");
    expect(dir!.path).toBe("/EDIABAS/Ecu");
    expect(dir!.name).toBe("Ecu");
    expect(await dir!.entries()).toEqual([{ kind: "file", name: "MS43.PRG", size: 12 }]);
    // And a child looked up through the directory folds too.
    expect((await dir!.file("ms43.prg"))?.name).toBe("MS43.PRG");
  });

  it("stays exact when not asked to fold", async () => {
    const { impl } = serving({});
    const fs = httpFileSystem("http://host/data", { fetch: impl, manifest: MIXED });
    expect(await fs.file("/EDIABAS/Ecu/MS43.PRG")).not.toBeNull();
    expect(await fs.file("/ediabas/ecu/ms43.prg")).toBeNull();
    expect(await fs.caseCollisions()).toEqual([]);
  });

  it("reports paths that differ only in case, and resolves them deterministically", async () => {
    const colliding: Manifest = {
      csfs: 1,
      // Deliberately out of sorted order: which one wins must be a property of
      // the tree, not of JSON key order, or a rebuilt manifest resolves
      // differently from the one it replaced.
      files: { "/ecu/ms43.prg": 2, "/ecu/MS43.PRG": 1, "/ecu/other.prg": 3 },
    };
    const { fs } = open(colliding);
    expect(await fs.caseCollisions()).toEqual([["/ecu/MS43.PRG", "/ecu/ms43.prg"]]);
    // Sorted order picks the winner, so it is the same on every build.
    expect((await fs.file("/ECU/ms43.prg"))!.path).toBe("/ecu/MS43.PRG");
    // An exact match still beats the fold, so the shadowed file is not lost to
    // a caller that spells it exactly.
    expect((await fs.file("/ecu/ms43.prg"))!.path).toBe("/ecu/ms43.prg");
  });
});
