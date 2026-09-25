/**
 * OPFS, and `fsa` over a real directory handle.
 *
 * The in-memory fake the unit tests use is only as good as its imitation, and
 * AGENTS.md asks two things of it: names are case-sensitive, and a missing or
 * wrong-kind entry rejects with `NotFoundError` or `TypeMismatchError`. OPFS
 * hands out a real `FileSystemDirectoryHandle` with no picker, so here those
 * claims are checked against the engines themselves.
 *
 * Every test starts from an empty origin: a fresh context, or on WebKit — which
 * gives an ephemeral context no OPFS at all — a fresh persistent profile. See
 * `storage` in `fixtures.ts`.
 */
import { expect, storage as test } from "./fixtures.js";
import type { Page } from "@playwright/test";

// In order, one profile at a time: WebKit fails OPFS calls with a "transient"
// `UnknownError` when several persistent profiles use it at once.
test.describe.configure({ mode: "default" });

/** Can this engine write to OPFS from a page? WebKit came to `createWritable` late. */
async function canWrite(page: Page): Promise<boolean> {
  return await page.evaluate(
    () =>
      typeof FileSystemFileHandle !== "undefined" &&
      "createWritable" in FileSystemFileHandle.prototype,
  );
}

test("writes, reads back, and reports itself as opfs", async ({ harness }) => {
  test.skip(!(await canWrite(harness)), "no createWritable in this engine");
  const result = await harness.evaluate(async () => {
    const { opfs } = window.csfs;
    const fs = await opfs.opfsFileSystem({ namespace: "e2e/nested" });
    await fs.write("/a/b/c.txt", new TextEncoder().encode("written"));
    const streamed = new Blob([new Uint8Array(100_000).fill(9)]).stream();
    await fs.write("/a/big.bin", streamed as ReadableStream<Uint8Array>);
    const big = (await fs.file("/a/big.bin"))!;
    return {
      kind: fs.kind,
      text: await (await fs.file("/a/b/c.txt"))!.text(),
      size: big.size,
      tail: [...(await big.slice(-2).bytes())],
      listing: (await (await fs.directory("/a"))!.entries())
        .map((e) => `${e.kind}:${e.name}`)
        .sort(),
    };
  });
  expect(result).toEqual({
    kind: "opfs",
    text: "written",
    size: 100_000,
    tail: [9, 9],
    listing: ["directory:b", "file:big.bin"],
  });
});

test("keeps what it wrote across a reload", async ({ harness }) => {
  test.skip(!(await canWrite(harness)), "no createWritable in this engine");
  await harness.evaluate(async () => {
    const fs = await window.csfs.opfs.opfsFileSystem({ namespace: "e2e" });
    await fs.write("/kept.txt", new TextEncoder().encode("still here"));
  });
  await harness.reload();
  await harness.waitForSelector("body[data-ready='1']");
  const text = await harness.evaluate(async () => {
    const fs = await window.csfs.opfs.opfsFileSystem({ namespace: "e2e" });
    return await (await fs.file("/kept.txt"))!.text();
  });
  expect(text).toBe("still here");
});

test("rejects with the error names the fake imitates", async ({ harness, browserName }) => {
  test.skip(!(await canWrite(harness)), "no createWritable in this engine");
  const names = await harness.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.getDirectoryHandle("dir", { create: true });
    await root.getFileHandle("file.txt", { create: true });
    const name = (p: Promise<unknown>) => p.then(() => "resolved").catch((e: Error) => e.name);
    return {
      missing: await name(root.getDirectoryHandle("nope")),
      fileAsDir: await name(root.getDirectoryHandle("file.txt")),
      dirAsFile: await name(root.getFileHandle("dir")),
      // Another name on Chromium and Firefox. WebKit folds, as its disk does.
      otherCase: await name(root.getFileHandle("FILE.TXT")),
    };
  });
  expect({ ...names, otherCase: undefined }).toEqual({
    missing: "NotFoundError",
    fileAsDir: "TypeMismatchError",
    dirAsFile: "TypeMismatchError",
    otherCase: undefined,
  });
  // Another name on Chromium and Firefox. WebKit follows its disk: it folds on
  // macOS, which is how this was found — AGENTS.md and the fake both said
  // OPFS was case-sensitive everywhere — and need not on Linux. csfs is
  // tested against both in `fsa-fs.test.ts`; here, only that the engine
  // answers one of the two ways.
  if (browserName === "webkit")
    expect(["resolved", "NotFoundError"]).toContain(names.otherCase);
  else expect(names.otherCase).toBe("NotFoundError");
});

test("fsa over a real handle: null for absence, a reason for a failed write", async ({
  harness,
}) => {
  test.skip(!(await canWrite(harness)), "no createWritable in this engine");
  const result = await harness.evaluate(async () => {
    const { fsa } = window.csfs;
    const handle = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("fsa", {
      create: true,
    });
    const fs = fsa.fsaFileSystem(handle);
    await fs.write("/f.txt", new TextEncoder().encode("x"));
    await fs.makeDirectory("/d");
    const failed = await fs
      .write("/d", new TextEncoder().encode("x"))
      .then(() => "written")
      .catch((e: Error) => e.message);
    return {
      dirAsFile: await fs.file("/d"),
      fileAsDir: await fs.directory("/f.txt"),
      absent: await fs.file("/nope"),
      failed,
      access: await fsa.queryAccess(handle, "readwrite"),
      rootStat: await fs.stat("/"),
    };
  });
  expect(result.dirAsFile).toBeNull();
  expect(result.fileAsDir).toBeNull();
  expect(result.absent).toBeNull();
  expect(result.failed).toMatch(/could not be created \(TypeMismatchError/);
  // Granted on every engine: Chromium says so, and Firefox and WebKit have no
  // permission API on handles, which csfs reads as access rather than refusal.
  expect(result.access).toBe(true);
  expect(result.rootStat).toEqual({ kind: "directory", name: "", size: 0 });
});

test("case-insensitively, writes nested paths and answers with stored names", async ({
  harness,
}) => {
  test.skip(!(await canWrite(harness)), "no createWritable in this engine");
  const result = await harness.evaluate(async () => {
    const fs = await window.csfs.opfs.opfsFileSystem({
      namespace: "ci",
      caseInsensitive: true,
    });
    await fs.write("/EPC/DATA1/PREF.BIN", new TextEncoder().encode("hello"));
    await fs.write("/epc/data1/other.bin", new TextEncoder().encode("second"));
    const root = await navigator.storage.getDirectory();
    const epc = await (await root.getDirectoryHandle("ci")).getDirectoryHandle("EPC");
    const stored: string[] = [];
    for await (const [name] of (await epc.getDirectoryHandle(
      "DATA1",
    )) as unknown as AsyncIterable<[string]>) {
      stored.push(name);
    }
    return {
      found: (await fs.file("/epc/data1/pref.bin"))!.path,
      stored: stored.sort(),
    };
  });
  // The second write went into the directories the first created, not into
  // a lower-case copy of them.
  expect(result).toEqual({
    found: "/EPC/DATA1/PREF.BIN",
    stored: ["PREF.BIN", "other.bin"],
  });
});

test("removes, refuses the root, and clears a namespace", async ({ harness }) => {
  test.skip(!(await canWrite(harness)), "no createWritable in this engine");
  const result = await harness.evaluate(async () => {
    const { opfs } = window.csfs;
    const fs = await opfs.opfsFileSystem({ namespace: "rm" });
    await fs.makeDirectory("/empty");
    await fs.remove("/empty");
    await fs.remove("/never-was");
    const root = await fs
      .remove("/", { recursive: true })
      .then(() => "removed")
      .catch((e: Error) => e.name);
    await fs.write("/x.txt", new TextEncoder().encode("x"));
    await opfs.clearNamespace("rm");
    await opfs.clearNamespace("rm");
    const whole = await opfs
      .clearNamespace("")
      .then(() => "cleared")
      .catch((e: Error) => e.message);
    const reopened = await opfs.opfsFileSystem({ namespace: "rm" });
    return {
      empty: await fs.directory("/empty"),
      root,
      afterClear: await reopened.file("/x.txt"),
      whole,
      // Firefox prompts, and headless there is nobody to answer; the signal
      // is what keeps this from waiting forever.
      persisted: typeof (await opfs.persist({ signal: AbortSignal.timeout(2000) })),
    };
  });
  expect(result).toEqual({
    empty: null,
    root: "UnsupportedOperationError",
    afterClear: null,
    whole: expect.stringMatching(/refusing to clear the whole origin/),
    persisted: "boolean",
  });
});
