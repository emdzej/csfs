/**
 * An archive, as a file system.
 *
 * A zip stores a flat list of entries whose names happen to contain slashes;
 * it has no directories in the sense a caller means. So the entry list is read
 * once and a tree is synthesised from it — including directories that exist
 * only implicitly, because plenty of archives never write directory entries at
 * all and a tree that omitted them would lose every file inside.
 *
 * The central directory is read on first use and kept. That is one round trip
 * of a couple of megabytes for a large archive — 2.2 MB for 38,488 entries —
 * after which every lookup is a map hit and every read is one range request.
 * Re-reading it per file would cost more than the files.
 */
import { ZipReader, type Entry, type FileEntry } from "@zip.js/zip.js";
import {
  BackendError,
  basename,
  bytesFile,
  dirname,
  mimeType,
  normalizePath,
  segments,
  statVia,
  type CsDirectory,
  type CsEntry,
  type CsFile,
  type CsFileSystem,
  type CsStat,
} from "@emdzej/csfs-core";
import { CsFileReader } from "./reader.js";

export interface ZipFileSystemOptions {
  /**
   * Match entry names without regard to case.
   *
   * Off by default. Archives built on Windows are inconsistent about case and
   * some data sets rely on that, but two entries differing only in case then
   * become ambiguous — so it is a choice the caller makes knowingly.
   */
  caseInsensitive?: boolean;
  /** Password, for the archives that need one. */
  password?: string;
}

interface Node {
  readonly name: string;
  /**
   * Only a `FileEntry` can be read: `Entry` is a union with `DirectoryEntry`,
   * which has no `getData`. Narrowing here rather than at each read means the
   * tree cannot hold something unreadable in a file position.
   */
  readonly entry?: FileEntry;
  readonly children: Map<string, Node>;
}

function keyOf(name: string, caseInsensitive: boolean): string {
  return caseInsensitive ? name.toLowerCase() : name;
}

export class ZipFileSystem implements CsFileSystem {
  readonly kind = "zip";
  private tree?: Promise<Node>;

  constructor(
    private readonly archive: CsFile,
    private readonly opts: ZipFileSystemOptions = {},
  ) {}

  /** Read the central directory once and build the tree from it. */
  private load(): Promise<Node> {
    this.tree ??= (async () => {
      const reader = new ZipReader(new CsFileReader(this.archive), {
        // `zip.js` would otherwise spin up workers, which is wrong for a
        // library: a consumer may already be inside one, and a page that reads
        // three files should not start a worker pool to do it.
        useWebWorkers: false,
      });
      let entries: Entry[];
      try {
        entries = await reader.getEntries();
      } catch (e) {
        throw new BackendError(
          `not a readable zip archive: ${e instanceof Error ? e.message : String(e)}`,
          this.archive.path,
        );
      }

      const insensitive = this.opts.caseInsensitive ?? false;
      const root: Node = { name: "", children: new Map() };
      for (const entry of entries) {
        const parts = segments(entry.filename);
        if (parts.length === 0) continue;
        let node = root;
        // Every parent is created on the way down, whether or not the archive
        // bothered to store a directory entry for it.
        for (const part of parts.slice(0, -1)) {
          const key = keyOf(part, insensitive);
          let next = node.children.get(key);
          if (!next) {
            next = { name: part, children: new Map() };
            node.children.set(key, next);
          }
          node = next;
        }
        const last = parts[parts.length - 1]!;
        const key = keyOf(last, insensitive);
        if (entry.directory) {
          if (!node.children.has(key)) {
            node.children.set(key, { name: last, children: new Map() });
          }
        } else {
          // A later entry with the same name replaces an earlier one, which is
          // what every unzip does.
          node.children.set(key, {
            name: last,
            entry: entry as FileEntry,
            children: new Map(),
          });
        }
      }
      return root;
    })();
    return this.tree;
  }

  private async nodeAt(path: string): Promise<Node | null> {
    const insensitive = this.opts.caseInsensitive ?? false;
    let node: Node | undefined = await this.load();
    for (const part of segments(path)) {
      node = node?.children.get(keyOf(part, insensitive));
      if (!node) return null;
    }
    return node ?? null;
  }

  /** Read one entry's bytes. */
  private async readEntry(entry: FileEntry, path: string): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    await entry.getData(sink, {
      ...(this.opts.password !== undefined ? { password: this.opts.password } : {}),
      useWebWorkers: false,
    });
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

  async file(path: string): Promise<CsFile | null> {
    const node = await this.nodeAt(path);
    if (!node?.entry) return null;
    const full = normalizePath(path);
    // Decompressed eagerly, and only on request. A `CsFile` promises random
    // access, and a deflated entry has no seekable form — offering a lazy
    // slice would mean re-inflating from the start for every read, which is
    // slower and more surprising than doing it once.
    const bytes = await this.readEntry(node.entry, full);
    return bytesFile(full, bytes, mimeType(full));
  }

  async directory(path: string): Promise<CsDirectory | null> {
    const node = await this.nodeAt(path);
    if (!node || node.entry) return null;
    return new ZipDirectory(this, node, normalizePath(path));
  }

  async read(path: string): Promise<Uint8Array | null> {
    return (await this.file(path))?.bytes() ?? null;
  }

  async stat(path: string): Promise<CsStat | null> {
    const root = await this.directory("/");
    if (!root) return null;
    if (segments(path).length === 0) return { kind: "directory", name: "", size: 0 };
    return await statVia(root, path);
  }

  /** Entry names as stored, for callers that want the flat view. */
  async names(): Promise<string[]> {
    const out: string[] = [];
    const visit = (node: Node, prefix: string): void => {
      for (const child of node.children.values()) {
        const p = `${prefix}/${child.name}`;
        if (child.entry) out.push(p);
        else visit(child, p);
      }
    };
    visit(await this.load(), "");
    return out;
  }

  /** @internal — `ZipDirectory` reaches back for this. */
  async entryFile(node: Node, path: string): Promise<CsFile | null> {
    if (!node.entry) return null;
    const bytes = await this.readEntry(node.entry, path);
    return bytesFile(path, bytes, mimeType(path));
  }
}

class ZipDirectory implements CsDirectory {
  readonly name: string;

  constructor(
    private readonly fs: ZipFileSystem,
    private readonly node: Node,
    readonly path: string,
  ) {
    this.name = basename(path);
  }

  async entries(): Promise<CsEntry[]> {
    return [...this.node.children.values()].map((child) =>
      child.entry
        ? { kind: "file" as const, name: child.name, size: child.entry.uncompressedSize }
        : { kind: "directory" as const, name: child.name },
    );
  }

  async file(name: string): Promise<CsFile | null> {
    return await this.fs.file(`${this.path}/${name}`);
  }

  async directory(name: string): Promise<CsDirectory | null> {
    return await this.fs.directory(`${this.path}/${name}`);
  }
}

/** Mount an archive. Nothing is read until something is asked for. */
export function zipFileSystem(archive: CsFile, opts?: ZipFileSystemOptions): ZipFileSystem {
  return new ZipFileSystem(archive, opts);
}

/** Re-exported so callers can build a path without importing core directly. */
export { dirname };
