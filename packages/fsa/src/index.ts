/**
 * A file system over a directory handle.
 *
 * Two things about the File System Access API shape this, and both are worth
 * knowing before using it:
 *
 * **There is no path lookup.** A handle resolves one segment at a time, each a
 * round trip, so `/a/b/c/d.txt` costs four. Resolved directories are therefore
 * cached — a tree with 3,500 directories and 228,000 files would otherwise
 * re-walk the same parents for every file inside them.
 *
 * **Permission does not survive a reload.** A handle can be stored in
 * IndexedDB, because it is structured-cloneable, but `queryPermission` reports
 * `"prompt"` afterwards even for one the user granted yesterday, and
 * `requestPermission` only works inside a user gesture. So a remembered
 * directory cannot be reopened silently on boot; the interface has to offer a
 * button. `queryAccess` and `requestAccess` are here so a consumer can tell
 * the two situations apart instead of discovering it as a failure.
 */
import {
  BlobFile,
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

/** Is the API available at all? It is Chromium-only at the time of writing. */
export function isFsaSupported(): boolean {
  return (
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
  );
}

/** Prompt for a directory. Rejects if the user cancels or the API is absent. */
export async function pickDirectory(
  mode: "read" | "readwrite" = "read",
): Promise<FileSystemDirectoryHandle> {
  const picker = (
    globalThis as {
      showDirectoryPicker?: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (typeof picker !== "function") {
    throw new Error("this browser has no File System Access API");
  }
  return await picker({ mode });
}

type PermissionMode = "read" | "readwrite";

interface PermissionCapable {
  queryPermission?(opts?: { mode?: PermissionMode }): Promise<PermissionState>;
  requestPermission?(opts?: { mode?: PermissionMode }): Promise<PermissionState>;
}

/** Can this handle be used without asking? */
export async function queryAccess(
  handle: FileSystemDirectoryHandle,
  mode: PermissionMode = "read",
): Promise<boolean> {
  try {
    return (await (handle as PermissionCapable).queryPermission?.({ mode })) === "granted";
  } catch {
    return false;
  }
}

/** Ask for access. **Must be called from a click or a keypress.** */
export async function requestAccess(
  handle: FileSystemDirectoryHandle,
  mode: PermissionMode = "read",
): Promise<boolean> {
  try {
    return (await (handle as PermissionCapable).requestPermission?.({ mode })) === "granted";
  } catch {
    return false;
  }
}

interface DirectoryHandleWithEntries extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

export interface FsaFileSystemOptions {
  /** Match names without regard to case. Costs a listing per lookup. */
  caseInsensitive?: boolean;
}

export class FsaFileSystem implements WritableFileSystem {
  readonly kind = "fsa";
  private readonly dirs = new Map<string, Promise<FileSystemDirectoryHandle | null>>();

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly opts: FsaFileSystemOptions = {},
  ) {
    this.dirs.set("/", Promise.resolve(root));
  }

  get name(): string {
    return this.root.name;
  }

  /** The handle, so a consumer can store it for next time. */
  get handle(): FileSystemDirectoryHandle {
    return this.root;
  }

  /** Resolve a directory, optionally creating it. Cached. */
  private dir(path: string, create = false): Promise<FileSystemDirectoryHandle | null> {
    const full = normalizePath(path);
    if (!create) {
      const hit = this.dirs.get(full);
      if (hit) return hit;
    }
    const promise = (async () => {
      let current: FileSystemDirectoryHandle = this.root;
      for (const name of segments(full)) {
        const resolved = this.opts.caseInsensitive
          ? await this.findChild(current, name, "directory")
          : name;
        if (resolved === null) return null;
        try {
          current = await current.getDirectoryHandle(resolved, { create });
        } catch {
          return null;
        }
      }
      return current;
    })();
    // Cached before it settles, so concurrent lookups share one walk rather
    // than racing to create the same directories.
    if (!create) this.dirs.set(full, promise);
    return promise;
  }

  /** Find a child's real name, ignoring case. `null` if there is none. */
  private async findChild(
    dir: FileSystemDirectoryHandle,
    name: string,
    kind: "file" | "directory",
  ): Promise<string | null> {
    const target = name.toLowerCase();
    for await (const [entryName, handle] of (dir as DirectoryHandleWithEntries).entries()) {
      if (handle.kind === kind && entryName.toLowerCase() === target) return entryName;
    }
    return null;
  }

  private async fileHandle(path: string, create = false): Promise<FileSystemFileHandle | null> {
    const full = normalizePath(path);
    const name = basename(full);
    if (name === "") return null;
    const parent = await this.dir(full.slice(0, full.length - name.length), create);
    if (!parent) return null;
    const resolved = this.opts.caseInsensitive
      ? ((await this.findChild(parent, name, "file")) ?? (create ? name : null))
      : name;
    if (resolved === null) return null;
    try {
      return await parent.getFileHandle(resolved, { create });
    } catch {
      return null;
    }
  }

  async file(path: string): Promise<CsFile | null> {
    const handle = await this.fileHandle(path);
    if (!handle) return null;
    const full = normalizePath(path);
    try {
      // A `File` *is* a `Blob`, which is what makes slicing a 945 MB archive
      // read only the slice.
      const file = (await handle.getFile()) as unknown as BlobLike;
      return new BlobFile(full, file, mimeType(full));
    } catch {
      return null;
    }
  }

  async directory(path: string): Promise<CsDirectory | null> {
    const handle = await this.dir(path);
    return handle ? new FsaDirectory(this, handle, normalizePath(path)) : null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return (await this.file(path))?.bytes() ?? null;
  }

  async stat(path: string): Promise<CsStat | null> {
    const full = normalizePath(path);
    if (segments(full).length === 0)
      return { kind: "directory", name: this.root.name, size: 0 };
    const file = await this.file(full);
    if (file) return { kind: "file", name: basename(full), size: file.size };
    const dir = await this.dir(full);
    return dir ? { kind: "directory", name: basename(full), size: 0 } : null;
  }

  async write(path: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const handle = await this.fileHandle(path, true);
    if (!handle) throw new Error(`${path}: could not be created`);
    // `createWritable` stages into a temporary file and swaps on close, so a
    // crash mid-write leaves the previous content rather than a truncated
    // file. The cost is that write traffic roughly doubles; OPFS has
    // `createSyncAccessHandle` to avoid that, and this API does not.
    const writable = await handle.createWritable();
    if (data instanceof Uint8Array) {
      // A `Uint8Array` is a valid write chunk; the DOM lib's
      // `FileSystemWriteChunkType` is a union that TypeScript will not accept
      // a generic `Uint8Array<ArrayBufferLike>` for, so the cast is at the
      // boundary rather than in the signature.
      await writable.write(data as unknown as FileSystemWriteChunkType);
      await writable.close();
      return;
    }
    // `pipeTo` closes and, on failure, aborts the writable itself, so closing
    // here as well would throw a second, less useful error over the first.
    await data.pipeTo(writable as unknown as WritableStream<Uint8Array>);
  }

  async makeDirectory(path: string): Promise<void> {
    if (!(await this.dir(path, true))) throw new Error(`${path}: could not be created`);
  }

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const full = normalizePath(path);
    const name = basename(full);
    const parent = await this.dir(full.slice(0, full.length - name.length));
    if (!parent) return;
    await (
      parent as FileSystemDirectoryHandle & {
        removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
      }
    ).removeEntry(name, { recursive: opts.recursive ?? false });
    this.dirs.delete(full);
  }
}

class FsaDirectory implements CsDirectory {
  readonly name: string;

  constructor(
    private readonly fs: FsaFileSystem,
    private readonly handle: FileSystemDirectoryHandle,
    readonly path: string,
  ) {
    this.name = handle.name;
  }

  async entries(): Promise<CsEntry[]> {
    const out: CsEntry[] = [];
    for await (const [name, handle] of (this.handle as DirectoryHandleWithEntries).entries()) {
      if (handle.kind === "directory") {
        out.push({ kind: "directory", name });
      } else {
        // `getFile()` per entry would be a round trip each, and a listing of
        // 24,000 files does not need sizes. `0` here means "ask the file", and
        // `walk` does exactly that when a size is wanted.
        out.push({ kind: "file", name, size: 0 });
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

/** Wrap a directory handle. */
export function fsaFileSystem(
  handle: FileSystemDirectoryHandle,
  opts?: FsaFileSystemOptions,
): FsaFileSystem {
  return new FsaFileSystem(handle, opts);
}
