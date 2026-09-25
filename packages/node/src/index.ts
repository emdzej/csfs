/**
 * `CsFileSystem` over `node:fs`.
 *
 * Exists for tooling and tests rather than for the browser, and that makes it
 * the reference implementation: the same suite that runs against a picked
 * directory or OPFS can run here without a browser, so a backend bug shows up
 * in a unit test rather than in a tab.
 *
 * `openAsBlob` is what makes it a peer of the others: it hands back a `Blob`
 * backed by the file, so slicing a 945 MB archive reads only the slice.
 */
import { openAsBlob } from "node:fs";
import { readdir, mkdir, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname as nodeDirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import {
  BlobFile,
  UnsupportedOperationError,
  basename,
  mimeType,
  normalizePath,
  segments,
  type BlobLike,
  type CsDirectory,
  type CsEntry,
  type CsFile,
  type CsStat,
  type WritableFileSystem,
} from "@emdzej/csfs-core";

export class NodeFileSystem implements WritableFileSystem {
  readonly kind = "node";

  constructor(private readonly root: string) {}

  /** The host path this file system is rooted at. */
  get rootPath(): string {
    return this.root;
  }

  private rootReal: Promise<string> | undefined;

  /** Resolve a csfs path against the root, using the platform separator. */
  private real(path: string): string {
    return join(this.root, ...segments(path));
  }

  /**
   * The path as the disk spells it.
   *
   * No folding layer here, on purpose — APFS and NTFS have already decided —
   * but a folding host still answers `/ecu/ms43.prg` for `MS43.PRG`, and
   * building the answer from the argument echoed the caller's spelling back:
   * the wrong answer shaped like a right one that every other backend was
   * fixed for in 0.2.0.
   *
   * One `realpath` finds the stored spelling, and when every segment already
   * matches it — a case-sensitive host, or a caller who spelled it right — that
   * one syscall is the whole cost. A segment that differs is settled by its
   * parent's listing: an exact name there wins, then a name differing only in
   * case. The listing, not `realpath`, because `realpath` follows symlinks and
   * a link's stored name is its own, not its target's.
   */
  private async stored(full: string): Promise<string> {
    const parts = segments(full);
    if (parts.length === 0) return full;
    let found: string[];
    try {
      this.rootReal ??= realpath(this.root);
      const [root, target] = await Promise.all([this.rootReal, realpath(this.real(full))]);
      found = relative(root, target).split(sep);
    } catch {
      return full;
    }
    // A link to somewhere of another depth leaves nothing to line up against.
    const aligned = found.length === parts.length;
    if (aligned && found.every((d, i) => d === parts[i])) return full;
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const asked = parts[i]!;
      if (aligned && found[i] === asked) {
        out.push(asked);
        continue;
      }
      const names: string[] = await readdir(this.real(`/${out.join("/")}`)).catch(() => []);
      const folded = asked.toLowerCase();
      out.push(
        names.includes(asked)
          ? asked
          : (names.find((n) => n.toLowerCase() === folded) ?? asked),
      );
    }
    return `/${out.join("/")}`;
  }

  async file(path: string): Promise<CsFile | null> {
    const full = normalizePath(path);
    try {
      const st = await stat(this.real(full));
      if (!st.isFile()) return null;
      const blob = (await openAsBlob(this.real(full))) as unknown as BlobLike;
      const name = await this.stored(full);
      return new BlobFile(name, blob, mimeType(name));
    } catch {
      return null;
    }
  }

  async directory(path: string): Promise<CsDirectory | null> {
    const full = normalizePath(path);
    try {
      const st = await stat(this.real(full));
      if (!st.isDirectory()) return null;
    } catch {
      return null;
    }
    return new NodeDirectory(this, await this.stored(full));
  }

  async read(path: string): Promise<Uint8Array | null> {
    return (await this.file(path))?.bytes() ?? null;
  }

  async stat(path: string): Promise<CsStat | null> {
    if (segments(path).length === 0) {
      return (await this.directory("/")) ? { kind: "directory", name: "", size: 0 } : null;
    }
    // Straight to `fs.stat` rather than through the parent's listing: on a
    // local filesystem one stat is cheaper than a whole directory read.
    let st;
    try {
      st = await stat(this.real(path));
    } catch {
      return null;
    }
    // A socket or a FIFO is neither, and `file()` will not open one, so `stat`
    // does not call it a file either.
    if (!st.isDirectory() && !st.isFile()) return null;
    const name = basename(await this.stored(normalizePath(path)));
    return st.isDirectory()
      ? { kind: "directory", name, size: 0 }
      : { kind: "file", name, size: st.size };
  }

  async write(path: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const target = this.real(path);
    await mkdir(nodeDirname(target), { recursive: true });
    if (data instanceof Uint8Array) {
      await writeFile(target, data);
      return;
    }
    await writeFile(target, Readable.fromWeb(data as never));
  }

  async makeDirectory(path: string): Promise<void> {
    await mkdir(this.real(path), { recursive: true });
  }

  /**
   * Remove a file, an empty directory, or with `recursive` a tree. Succeeds if
   * the path is already absent.
   *
   * `rm` without `recursive` refuses every directory, empty or not
   * (`ERR_FS_EISDIR`), so the interface's "or an empty directory" failed here
   * while it worked on `fsa`. And `real("/")` is the root itself, which
   * `remove("/", { recursive: true })` deleted — where `fsa` refused.
   */
  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    if (segments(path).length === 0)
      throw new UnsupportedOperationError("remove the root", this.kind);
    const target = this.real(path);
    if (!opts.recursive) {
      const st = await stat(target).catch(() => null);
      // `rmdir` refuses a non-empty directory, which is the point.
      if (st?.isDirectory()) return await rmdir(target);
    }
    await rm(target, { recursive: opts.recursive ?? false, force: true });
  }
}

class NodeDirectory implements CsDirectory {
  readonly name: string;

  constructor(
    private readonly fs: NodeFileSystem,
    readonly path: string,
  ) {
    this.name = basename(path);
  }

  async entries(): Promise<CsEntry[]> {
    const real = join(this.fs.rootPath, ...segments(this.path));
    // Only a directory that vanished is empty. A permission error used to be
    // too, so an unreadable directory listed as `[]` here and threw on `fsa`.
    const found = await readdir(real, { withFileTypes: true }).catch((e: unknown) => {
      if ((e as { code?: string }).code === "ENOENT") return [];
      throw e;
    });
    // Resolved lazily, and only for a directory that has a symlink in it.
    let here: Promise<string> | undefined;
    // The stats run concurrently, a batch at a time: one after another made a
    // listing of 20,000 files 20,000 sequential round trips to the thread pool.
    const one = async (e: (typeof found)[number]): Promise<CsEntry | null> => {
      if (e.isDirectory()) return { kind: "directory", name: e.name };
      // A symlink is neither `isFile()` nor `isDirectory()` — `readdir` does
      // not follow it — so testing only those two dropped every symlinked file
      // from the listing, and therefore from any manifest built by walking.
      // `stat` follows, which is why `file()` could read a path that `entries()`
      // had never mentioned. Anything that is not a directory and not a plain
      // file (a socket, a device) still falls out here.
      if (!e.isFile() && !e.isSymbolicLink()) return null;
      // Sizes cost a stat each. Reported anyway: a listing without them
      // forces every caller that wants one into a second round of calls,
      // and on a local filesystem the stat is cheap.
      const st = await stat(join(real, e.name)).catch(() => undefined);
      if (!st) {
        // A broken symlink, or one pointing outside anything readable. Listed
        // as a zero-length file rather than dropped: it *is* an entry, and a
        // caller that tries to read it gets the failure at the point it can
        // report which path was bad.
        return { kind: "file", name: e.name, size: 0 };
      }
      if (st.isDirectory()) {
        // A link to this directory or one above it is a loop, and `walk` —
        // with nothing to recognise a directory by but its path — descended
        // it until the path was too long, while `buildManifest` recorded every
        // copy on the way down. Left out of the listing; it can still be
        // opened by name.
        if (e.isSymbolicLink()) {
          here ??= realpath(real);
          const [self, target] = await Promise.all([
            here,
            realpath(join(real, e.name)).catch(() => null),
          ]);
          if (target !== null && (self === target || self.startsWith(target + sep)))
            return null;
        }
        return { kind: "directory", name: e.name };
      }
      if (!st.isFile()) return null;
      return { kind: "file", name: e.name, size: st.size };
    };
    const out: CsEntry[] = [];
    const BATCH = 64;
    for (let i = 0; i < found.length; i += BATCH) {
      for (const entry of await Promise.all(found.slice(i, i + BATCH).map(one))) {
        if (entry) out.push(entry);
      }
    }
    return out;
  }

  async file(name: string): Promise<CsFile | null> {
    return await this.fs.file(`${this.path}/${name}`);
  }

  async directory(name: string): Promise<CsDirectory | null> {
    return await this.fs.directory(`${this.path}/${name}`);
  }
}

/** Open a directory as a file system. */
export function nodeFileSystem(root: string): NodeFileSystem {
  return new NodeFileSystem(root);
}
