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
