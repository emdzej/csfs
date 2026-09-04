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
import { readdir, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname as nodeDirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import {
  BlobFile,
  basename,
  mimeType,
  normalizePath,
  segments,
  statVia,
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

  /** Resolve a csfs path against the root, using the platform separator. */
  private real(path: string): string {
    return join(this.root, ...segments(path));
  }

  async file(path: string): Promise<CsFile | null> {
    const full = normalizePath(path);
    try {
      const st = await stat(this.real(full));
      if (!st.isFile()) return null;
      const blob = (await openAsBlob(this.real(full))) as unknown as BlobLike;
      return new BlobFile(full, blob, mimeType(full));
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
    return new NodeDirectory(this, full);
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
    try {
      const st = await stat(this.real(path));
      return st.isDirectory()
        ? { kind: "directory", name: basename(path), size: 0 }
        : { kind: "file", name: basename(path), size: st.size };
    } catch {
      return null;
    }
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

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await rm(this.real(path), { recursive: opts.recursive ?? false, force: true });
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
    const found = await readdir(real, { withFileTypes: true }).catch(() => []);
    const out: CsEntry[] = [];
    for (const e of found) {
      if (e.isDirectory()) {
        out.push({ kind: "directory", name: e.name });
      } else if (e.isFile()) {
        // Sizes cost a stat each. Reported anyway: a listing without them
        // forces every caller that wants one into a second round of calls,
        // and on a local filesystem the stat is cheap.
        const st = await stat(join(real, e.name)).catch(() => undefined);
        out.push({ kind: "file", name: e.name, size: st?.size ?? 0 });
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

export { statVia, sep };
