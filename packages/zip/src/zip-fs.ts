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
  RangeFile,
  blobFile,
  shared,
  mimeType,
  segments,
  type CsDirectory,
  type CsEntry,
  type CsFile,
  type CsFileSystem,
  type CsStat,
  type ReadOptions,
  type BlobLike,
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

/** Stored without compression or encryption, on the archive's only disk. */
function isStored(entry: FileEntry): boolean {
  return entry.compressionMethod === 0 && !entry.encrypted && !entry.diskNumberStart;
}

function oneChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A stream whose source is only known once something asks for a byte. */
function lazyStream(
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  const cancel = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= (await open(cancel.signal)).getReader();
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      cancel.abort(reason);
      await reader?.cancel(reason);
    },
  });
}

export class ZipFileSystem implements CsFileSystem {
  readonly kind = "zip";
  private tree: Promise<Node> | undefined;

  constructor(
    private readonly archive: CsFile,
    private readonly opts: ZipFileSystemOptions = {},
  ) {}

  /**
   * Read the central directory once and build the tree from it.
   *
   * Once it has *succeeded*: a failed read is dropped, so a transient error
   * fetching the directory does not make the archive unreadable for as long as
   * this object lives.
   */
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
        // A store's own errors pass through as they are. `NotDataError` and
        // `RangeUnsupportedError` need opposite handling, and wrapping them as
        // "not a readable zip" sent every caller down the corrupt-archive path.
        if (e instanceof BackendError) throw e;
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
    })().catch((e: unknown) => {
      this.tree = undefined;
      throw e;
    });
    return this.tree;
  }

  /**
   * Walk to a node, and report the path it was found at.
   *
   * The path is rebuilt from the nodes' own names rather than reused from the
   * argument, because under `caseInsensitive` the two differ — and the name a
   * caller gets back should be the one the archive stores, not the one they
   * happened to type.
   */
  private async nodeAt(path: string): Promise<{ node: Node; path: string } | null> {
    const insensitive = this.opts.caseInsensitive ?? false;
    let node: Node | undefined = await this.load();
    const found: string[] = [];
    for (const part of segments(path)) {
      node = node?.children.get(keyOf(part, insensitive));
      if (!node) return null;
      found.push(node.name);
    }
    return node ? { node, path: `/${found.join("/")}` } : null;
  }

  /**
   * Read one entry's bytes.
   *
   * Straight into a buffer sized from the central directory. Collecting the
   * chunks and concatenating them held every byte twice at the peak, which for
   * a 100 MB entry is 200 MB. The size is trusted only as a starting point: an
   * entry that inflates past it grows the buffer rather than being cut short.
   */
  private async readEntry(entry: FileEntry, signal: AbortSignal): Promise<Uint8Array> {
    let out = new Uint8Array(entry.uncompressedSize);
    let at = 0;
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        if (at + chunk.byteLength > out.byteLength) {
          const grown = new Uint8Array(Math.max(out.byteLength * 2, at + chunk.byteLength));
          grown.set(out.subarray(0, at));
          out = grown;
        }
        out.set(chunk, at);
        at += chunk.byteLength;
      },
    });
    await entry.getData(sink, {
      ...(this.opts.password !== undefined ? { password: this.opts.password } : {}),
      useWebWorkers: false,
      signal,
    });
    // The file was sized from the central directory before a byte was read,
    // so an entry that inflates to another length would have handed out a
    // `size` that its bytes contradict.
    if (at !== entry.uncompressedSize) {
      throw new BackendError(
        `entry inflated to ${at} bytes where the archive says ${entry.uncompressedSize}`,
        `${this.archive.path}#/${entry.filename}`,
      );
    }
    return at === out.byteLength ? out : out.slice(0, at);
  }

  async file(path: string): Promise<CsFile | null> {
    const found = await this.nodeAt(path);
    if (!found?.node.entry) return null;
    const entry = found.node.entry;
    // Inflated on the first read, not at lookup, and once for the file and
    // every slice of it. A deflated entry has no seekable form, so a slice
    // cannot be inflated on its own — but inflating in `file()` made a lookup
    // cost the whole entry and left no way to cancel it. Shared, so the
    // inflation stops only when every reader waiting on it has aborted.
    const inflate = shared((signal) => this.readEntry(entry, signal));
    const inflated = async (start: number, end: number, signal?: AbortSignal) =>
      (await inflate(signal)).subarray(start, end);
    if (!isStored(entry)) {
      return new RangeFile(found.path, entry.uncompressedSize, inflated, mimeType(found.path));
    }
    // Stored, not compressed: the entry's bytes *are* a range of the archive,
    // so a slice of it is a slice of that — read by range over HTTP, streamed,
    // and never held whole. That is what makes an archive inside an archive
    // cheap, since archives are usually stored rather than deflated twice.
    // CRC is not checked on this path, as it cannot be for a partial read.
    const locate = shared((signal) => this.dataOffset(entry, signal));
    const archive = this.archive;
    return new RangeFile(
      found.path,
      entry.uncompressedSize,
      {
        read: async (start, end, signal) => {
          const at = await locate(signal);
          if (at === null) return await inflated(start, end, signal);
          return await archive.slice(at + start, at + end).bytes(signal ? { signal } : {});
        },
        stream: (start, end) =>
          lazyStream(async (signal) => {
            const at = await locate(signal);
            if (at === null) return oneChunk(await inflated(start, end, signal));
            return archive.slice(at + start, at + end).stream();
          }),
      },
      mimeType(found.path),
    );
  }

  /**
   * Where a stored entry's bytes begin, from its local header.
   *
   * The central directory gives the header's offset; the header's own name and
   * extra-field lengths — which may differ from the central directory's — give
   * the rest. `null` when the header is not where it should be, and the entry
   * is then read the ordinary way, through zip.js, which knows more about
   * malformed archives than this does.
   */
  private async dataOffset(entry: FileEntry, signal: AbortSignal): Promise<number | null> {
    const header = await this.archive.slice(entry.offset, entry.offset + 30).bytes({ signal });
    if (header.byteLength < 30) return null;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== 0x04034b50) return null;
    const at = entry.offset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
    if (at + entry.uncompressedSize > this.archive.size) {
      throw new BackendError(
        `entry runs past the end of the archive`,
        `${this.archive.path}#/${entry.filename}`,
      );
    }
    return at;
  }

  async directory(path: string): Promise<CsDirectory | null> {
    const found = await this.nodeAt(path);
    if (!found || found.node.entry) return null;
    return new ZipDirectory(this, found.node, found.path);
  }

  async read(path: string, opts?: ReadOptions): Promise<Uint8Array | null> {
    return (await this.file(path))?.bytes(opts) ?? null;
  }

  async stat(path: string): Promise<CsStat | null> {
    // Straight to the node rather than through `statVia`, which matches a
    // listing by exact name and so disagreed with `file()` about whether a
    // path existed whenever this archive was opened case-insensitively. It is
    // also cheaper: a map walk instead of scanning the parent's children.
    const found = await this.nodeAt(path);
    if (!found) return null;
    const { node } = found;
    return node.entry
      ? { kind: "file", name: node.name, size: node.entry.uncompressedSize }
      : { kind: "directory", name: node.name, size: 0 };
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

/**
 * Mount a `Blob` or a `File` as a file system.
 *
 * This is the whole answer to "can I open a zip the user picked?" — a `File`
 * *is* a `Blob`, so it already satisfies the read contract and needs no
 * adapter. It works from `showOpenFilePicker()`, from `<input type="file">`
 * and from a drop event, and the latter two work in every browser rather than
 * only in Chromium.
 *
 * One caveat worth passing on: a `File` is a snapshot of a path, not a lock on
 * it. If the archive changes on disk after being picked, later reads throw
 * rather than returning stale bytes — which is the right behaviour, but a
 * long-lived page should be ready to ask for it again.
 */
export function zipFromBlob(
  blob: BlobLike & { name?: string },
  opts: ZipFileSystemOptions & { path?: string } = {},
): ZipFileSystem {
  const { path, ...rest } = opts;
  return new ZipFileSystem(blobFile(blob, path, "application/zip"), rest);
}
