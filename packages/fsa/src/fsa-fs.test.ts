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

describe("errors that are not absence", () => {
  const refused = () => new DOMException("permission is prompt", "NotAllowedError");

  it("says a tree is locked rather than that it is empty", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root);
    await fs.write("/a/b.txt", bytes("x"));
    // What every call does after a reload, until `requestPermission` succeeds.
    const locked = fsaFileSystem(
      Object.assign(root, {
        getDirectoryHandle: async () => {
          throw refused();
        },
        getFileHandle: async () => {
          throw refused();
        },
      }),
    );
    await expect(locked.file("/a/b.txt")).rejects.toThrow(/permission/);
    await expect(locked.directory("/a")).rejects.toThrow(/permission/);
  });

  it("says why a write failed", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root);
    await fs.makeDirectory("/taken");
    // A directory already has the name.
    const err = await fs.write("/taken", bytes("x")).catch((e: unknown) => e);
    expect(String(err)).toMatch(/TypeMismatchError/);
    expect((err as Error).cause).toBeInstanceOf(DOMException);
  });

  it("still answers null for a file asked for as a directory, and the reverse", async () => {
    const fs = fsaFileSystem(fakeDirectory());
    await fs.write("/f.txt", bytes("x"));
    await fs.makeDirectory("/d");
    expect(await fs.directory("/f.txt")).toBeNull();
    expect(await fs.file("/d")).toBeNull();
  });
});

describe("remove", () => {
  it("refuses the root", async () => {
    const fs = fsaFileSystem(fakeDirectory());
    await expect(fs.remove("/", { recursive: true })).rejects.toThrow(/root/);
  });

  it("succeeds for something already absent", async () => {
    const fs = fsaFileSystem(fakeDirectory());
    await fs.remove("/nothing");
    await fs.remove("/no/parent/either");
  });

  it("removes an empty directory, and refuses a full one unless recursive", async () => {
    const fs = fsaFileSystem(fakeDirectory());
    await fs.makeDirectory("/empty");
    await fs.remove("/empty");
    expect(await fs.directory("/empty")).toBeNull();
    await fs.write("/full/x", bytes("x"));
    await expect(fs.remove("/full")).rejects.toThrow();
    await fs.remove("/full", { recursive: true });
    expect(await fs.directory("/full")).toBeNull();
  });
});

describe("cost", () => {
  it("lists a directory once, not once per write", async () => {
    const root = fakeDirectory();
    let listings = 0;
    const count = (dir: FileSystemDirectoryHandle): FileSystemDirectoryHandle => {
      const d = dir as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      };
      const entries = d.entries.bind(d);
      const get = d.getDirectoryHandle.bind(d);
      return Object.assign(d, {
        entries: () => {
          listings += 1;
          return entries();
        },
        getDirectoryHandle: async (n: string, o?: FileSystemGetDirectoryOptions) =>
          count(await get(n, o)),
      });
    };
    const fs = fsaFileSystem(count(root), { caseInsensitive: true });
    await fs.write("/a/b/c/0.bin", bytes("x"));
    listings = 0;
    for (let i = 1; i <= 10; i++) await fs.write(`/a/b/c/${i}.bin`, bytes("x"));
    // Every directory on the way was listed by the first write, and each
    // write since has kept the index current rather than listing again.
    expect(listings).toBe(0);
  });

  it("sees what another writer created, and what it removed", async () => {
    const root = fakeDirectory();
    const fs = fsaFileSystem(root, { caseInsensitive: true });
    const other = fsaFileSystem(root);
    await fs.write("/d/first.bin", bytes("1"));
    expect(await fs.file("/d/SECOND.bin")).toBeNull();
    // Behind this instance's back, as a second tab on the same OPFS would.
    await other.write("/d/Second.BIN", bytes("2"));
    expect((await fs.file("/d/second.bin"))?.name).toBe("Second.BIN");
    await other.remove("/d/first.bin");
    expect(await fs.file("/d/FIRST.bin")).toBeNull();
    expect(await fs.stat("/d/first.bin")).toBeNull();
  });

  it("keeps the index current through its own removals", async () => {
    const fs = fsaFileSystem(fakeDirectory(), { caseInsensitive: true });
    await fs.write("/d/A.bin", bytes("x"));
    await fs.remove("/d/a.BIN");
    expect(await fs.file("/d/A.bin")).toBeNull();
    await fs.write("/d/a.bin", bytes("y"));
    expect((await fs.file("/d/A.BIN"))?.name).toBe("a.bin");
  });

  it("stats a directory with one listing of its parent", async () => {
    const fs = fsaFileSystem(fakeDirectory(), { caseInsensitive: true });
    await fs.makeDirectory("/Ecu");
    expect(await fs.stat("/ECU")).toEqual({ kind: "directory", name: "Ecu", size: 0 });
    expect(await fs.stat("/")).toEqual({ kind: "directory", name: "", size: 0 });
  });

  it("prefers an exact spelling over a fold", async () => {
    const fs = fsaFileSystem(fakeDirectory(), { caseInsensitive: true });
    await fs.write("/x/A.BIN", bytes("upper"));
    // Written case-sensitively beside it, as another tool might.
    await fsaFileSystem((fs as unknown as { handle: FileSystemDirectoryHandle }).handle).write(
      "/x/a.bin",
      bytes("lower"),
    );
    expect(await text(await fs.file("/x/a.bin"))).toBe("lower");
    expect(await text(await fs.file("/x/A.BIN"))).toBe("upper");
  });
});
