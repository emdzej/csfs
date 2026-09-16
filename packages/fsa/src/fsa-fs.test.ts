/**
 * Name resolution and `create` semantics.
 *
 * The case-insensitive path is where the interesting failures are: it resolves
 * a name by listing the directory and comparing lowercased, which means every
 * lookup has to decide what "not there" implies. For a read it means null; for
 * a write it means "make it".
 */
import { describe, expect, it } from "vitest";
import { fakeDirectory } from "./fake-directory.js";
import type { CsFile } from "@emdzej/csfs-core";
import { fsaFileSystem } from "./index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
/** `CsFile` is Blob-shaped rather than a `Blob`, which is the whole point of it. */
const text = async (file: CsFile | null) =>
  file ? new TextDecoder().decode(await file.bytes()) : null;

describe("case-insensitive", () => {
  /**
   * The regression. `dir(path, create)` resolved each segment with
   * `findChild`, which returns null for a directory that does not exist yet,
   * and then returned null instead of creating it — so a write to any nested
   * path failed. It surfaced as `could not be created` on the *file*, with
   * nothing to say the parent was the problem, and a consumer copying a tree
   * saw it as "nothing is being written" rather than as an error.
   */
  it("creates missing directories on write", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });

    await fs.write("EPC/DATA1/A/PREF.BIN", bytes("hello"));

    expect(await root.paths()).toEqual(["EPC/DATA1/A/PREF.BIN"]);
    expect(await text(await fs.file("EPC/DATA1/A/PREF.BIN"))).toBe("hello");
  });

  it("reuses a directory whose case differs from the path asked for", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });

    await fs.write("Illust/113/a.tif", bytes("one"));
    // The other disc spells it in capitals; it is the same directory.
    await fs.write("ILLUST/113/b.tif", bytes("two"));

    expect(await root.paths()).toEqual(["Illust/113/a.tif", "Illust/113/b.tif"]);
  });

  it("finds a file whatever case it is asked for", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });
    await fs.write("EPC/DATA1/CInfo.ddm", bytes("schema"));

    expect(await text(await fs.file("epc/data1/cinfo.ddm"))).toBe("schema");
    expect(await text(await fs.file("EPC/DATA1/CINFO.DDM"))).toBe("schema");
  });

  /** Reading must not have the side effect that writing does. */
  it("does not create anything while reading", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });

    expect(await fs.file("EPC/DATA1/missing.bin")).toBeNull();
    expect(await fs.stat("EPC")).toBeNull();
    expect(await root.paths()).toEqual([]);
  });

  it("writes a stream as well as a buffer", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });
    const stream = new Blob([bytes("streamed")]).stream();

    await fs.write("deep/er/still/x.bin", stream);

    expect(await text(await fs.file("deep/er/still/x.bin"))).toBe("streamed");
  });

  /**
   * The name a caller gets back has to be the one on disk, not the one they
   * typed. It is passed on: bimmerz hands `file.name` to ediabasx, which pins
   * a variant by it, so echoing `ms43.prg` back at a disk holding `MS43.PRG`
   * is a wrong answer that looks like a right one.
   */
  it("answers with the name as stored, not as asked for", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });
    await fs.write("EDIABAS/Ecu/MS43.PRG", bytes("sgbd"));

    const file = await fs.file("ediabas/ecu/ms43.prg");
    expect(file!.name).toBe("MS43.PRG");
    expect(file!.path).toBe("/EDIABAS/Ecu/MS43.PRG");
    expect(await fs.stat("ediabas/ecu/ms43.prg")).toEqual({
      kind: "file",
      name: "MS43.PRG",
      size: 4,
    });

    const dir = await fs.directory("ediabas/ecu");
    expect(dir!.path).toBe("/EDIABAS/Ecu");
    expect(await fs.stat("ediabas/ecu")).toEqual({
      kind: "directory",
      name: "Ecu",
      size: 0,
    });
    // And through the directory, which is how a consumer holding a subtree
    // root reaches a file.
    expect((await dir!.file("ms43.prg"))!.name).toBe("MS43.PRG");
  });

  it("removes a file whose case differs from the path asked for", async () => {
    // `removeEntry` takes a literal name, so without resolving it first this
    // silently removed nothing — the one thing the option exists to prevent.
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });
    await fs.write("Ecu/MS43.PRG", bytes("sgbd"));

    await fs.remove("ecu/ms43.prg");

    expect(await root.paths()).toEqual([]);
  });

  it("forgets a directory it cached after the directory is removed", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });
    await fs.write("Ecu/a.bin", bytes("x"));
    // Cached under the spelling asked for, which is not the spelling on disk.
    expect(await fs.directory("ECU")).not.toBeNull();

    await fs.remove("ecu", { recursive: true });

    expect(await fs.directory("ECU")).toBeNull();
    expect(await fs.directory("Ecu")).toBeNull();
  });

  it("finds a directory that was created after a lookup missed it", async () => {
    // A miss used to be cached forever, so `directory(p)` kept answering null
    // after `makeDirectory(p)` had already succeeded.
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });

    expect(await fs.directory("later")).toBeNull();
    await fs.makeDirectory("later");
    expect(await fs.directory("later")).not.toBeNull();
  });
});

describe("case-sensitive", () => {
  it("creates missing directories on write", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root);

    await fs.write("EPC/DATA1/A/PREF.BIN", bytes("hello"));

    expect(await root.paths()).toEqual(["EPC/DATA1/A/PREF.BIN"]);
  });

  /** The whole point of the option: names are names. */
  it("treats a different case as a different name", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root);
    await fs.write("Illust/a.tif", bytes("one"));

    expect(await fs.file("ILLUST/a.tif")).toBeNull();
    await fs.write("ILLUST/a.tif", bytes("two"));
    expect(await root.paths()).toEqual(["ILLUST/a.tif", "Illust/a.tif"]);
  });
});
