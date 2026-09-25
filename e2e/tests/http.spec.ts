/**
 * `csfs-http` in a tab.
 *
 * Most of what is here passes under Node already. It is repeated because the
 * failures this backend guards against are the ones Node forgives: `fetch`
 * called with the wrong `this`, a CORS response whose headers the page cannot
 * read, a stream a browser cancels differently.
 */
import { expect, origins, test } from "./fixtures.js";

test.describe("reading over HTTP", () => {
  test("reads a whole file and a range, with the default fetch and an injected one", async ({
    harness,
  }) => {
    const { origin } = origins();
    const result = await harness.evaluate(async (base) => {
      const { http } = window.csfs;
      const expected = (at: number) => (at * 7) % 256;
      const out: string[] = [];
      // `{ fetch: window.fetch }` is what a caller passes; called as a method
      // it throws "Illegal invocation" in Chromium and a TypeError elsewhere.
      for (const opts of [{}, { fetch: window.fetch }]) {
        const fs = http.httpFileSystem(`${base}/data`, opts);
        const file = (await fs.file("/deep/nested/big.bin"))!;
        const slice = await file.slice(123_456, 123_466).bytes();
        const ok = [...slice].every((b, i) => b === expected(123_456 + i));
        out.push(`${file.size} ${ok} ${await fs.read("/top.txt").then((b) => b!.length)}`);
      }
      return out;
    }, `${origin}`);
    expect(result).toEqual(["1000000 true 10", "1000000 true 10"]);
  });

  test("sends one small Range request for a small slice", async ({ harness }) => {
    const { origin } = origins();
    const ranges: string[] = [];
    harness.on("request", (r) => {
      if (r.url().includes("big.bin")) ranges.push(r.headers()["range"] ?? "none");
    });
    await harness.evaluate(async (base) => {
      const fs = window.csfs.http.httpFileSystem(`${base}/data`);
      await (await fs.file("/deep/nested/big.bin"))!.slice(10, 20).bytes();
    }, origin);
    expect(ranges).toEqual(["bytes=10-19"]);
  });

  test("reads a tree whose host ignores Range, and says so", async ({ harness }) => {
    const { origin } = origins();
    const result = await harness.evaluate(async (base) => {
      const { http } = window.csfs;
      const auto = http.httpFileSystem(`${base}/norange`);
      const bytes = await (await auto.file("/deep/nested/big.bin"))!.slice(5, 8).bytes();
      const strict = http.httpFileSystem(`${base}/norange`, { ranges: "require" });
      const refused = await strict
        .read("/top.txt")
        .then(() => "read")
        .catch((e: Error) => e.name);
      return { bytes: [...bytes], supported: auto.rangesSupported, refused };
    }, origin);
    expect(result).toEqual({
      bytes: [35, 42, 49],
      supported: false,
      refused: "RangeUnsupportedError",
    });
  });

  test("refuses a single-page app's HTML, but reads an HTML file the tree lists", async ({
    harness,
  }) => {
    const { origin } = origins();
    const result = await harness.evaluate(async (base) => {
      const { http } = window.csfs;
      const spa = await http
        .httpFileSystem(`${base}/spa`)
        .describe()
        .then(() => "opened")
        .catch((e: Error) => e.name);
      const page = await http.httpFileSystem(`${base}/data`).file("/index.html");
      return { spa, page: await page!.text() };
    }, origin);
    expect(result).toEqual({ spa: "NotDataError", page: "<p>a page that is data</p>" });
  });

  test("decompresses a manifest uploaded gzipped", async ({ harness }) => {
    const { origin } = origins();
    const text = await harness.evaluate(async (base) => {
      const fs = window.csfs.http.httpFileSystem(`${base}/gz`);
      return await (await fs.file("/top.txt"))!.text();
    }, origin);
    expect(text).toBe("at the top");
  });

  test("encodes names a URL would take for syntax", async ({ harness }) => {
    const { origin } = origins();
    const text = await harness.evaluate(async (base) => {
      const fs = window.csfs.http.httpFileSystem(`${base}/data`);
      return await (await fs.file("/deep/odd name #1 100%?.txt"))!.text();
    }, origin);
    expect(text).toBe("oddly named");
  });

  test("answers a case-insensitive lookup with the name as stored", async ({ harness }) => {
    const { origin } = origins();
    const name = await harness.evaluate(async (base) => {
      const fs = window.csfs.http.httpFileSystem(`${base}/data`, { caseInsensitive: true });
      return (await fs.file("/ediabas/ecu/ms43.prg"))!.path;
    }, origin);
    expect(name).toBe("/EDIABAS/Ecu/MS43.PRG");
  });

  test("streams a range as it arrives, and stops fetching when cancelled", async ({
    harness,
  }) => {
    const { origin } = origins();
    const result = await harness.evaluate(async (base) => {
      const fs = window.csfs.http.httpFileSystem(`${base}/data`);
      const file = (await fs.file("/deep/nested/big.bin"))!;
      const whole = new Uint8Array(
        await new Response(file.slice(0, 300_000).stream()).arrayBuffer(),
      );
      const ok = whole.every((b, i) => b === (i * 7) % 256);
      const reader = file.stream().getReader();
      const first = await reader.read();
      await reader.cancel("enough");
      return { length: whole.length, ok, firstChunkSmall: first.value!.length < 1_000_000 };
    }, origin);
    expect(result).toEqual({ length: 300_000, ok: true, firstChunkSmall: true });
  });

  test("rejects a cancelled read with the signal's reason", async ({ harness }) => {
    const { origin } = origins();
    const name = await harness.evaluate(async (base) => {
      const fs = window.csfs.http.httpFileSystem(`${base}/data`);
      const controller = new AbortController();
      const read = fs.read("/deep/nested/big.bin", { signal: controller.signal });
      controller.abort();
      return await read.then(() => "read").catch((e: Error) => e.name);
    }, origin);
    expect(name).toBe("AbortError");
  });

  test("gives an <img> a direct URL that loads", async ({ harness }) => {
    const { origin } = origins();
    const width = await harness.evaluate(async (base) => {
      const fs = window.csfs.http.httpFileSystem(`${base}/data`);
      const img = new Image();
      img.src = (await fs.directUrl("/img/dot.png"))!;
      await img.decode();
      return img.naturalWidth;
    }, origin);
    expect(width).toBe(1);
  });
});

test.describe("reading across origins", () => {
  test("reads by range from a host that sends CORS headers", async ({ harness }) => {
    const { cross } = origins();
    const result = await harness.evaluate(async (base) => {
      const fs = window.csfs.http.httpFileSystem(`${base}/data`);
      const bytes = await (await fs.file("/deep/nested/big.bin"))!.slice(1000, 1003).bytes();
      return { bytes: [...bytes], supported: fs.rangesSupported };
    }, cross);
    expect(result).toEqual({ bytes: [88, 95, 102], supported: true });
  });

  test("still reads correctly when the host does not expose Content-Range", async ({
    harness,
  }) => {
    // The page then cannot see the header at all; the length check is what
    // is left, and it has to be enough.
    const { cross } = origins();
    const bytes = await harness.evaluate(async (base) => {
      const fs = window.csfs.http.httpFileSystem(`${base}/noexpose`);
      return [...(await (await fs.file("/deep/nested/big.bin"))!.slice(1000, 1003).bytes())];
    }, cross);
    expect(bytes).toEqual([88, 95, 102]);
  });
});
