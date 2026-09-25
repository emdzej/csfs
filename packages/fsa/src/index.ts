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
  BackendError,
  BlobFile,
  UnsupportedOperationError,
  basename,
  joinPath,
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

/**
 * Prompt for a single file.
 *
 * The companion to `pickDirectory`, and the way to open an archive: the
 * returned `File` is a `Blob`, so `zipFromBlob` mounts it directly.
 *
 * Chromium-only, like the rest of this API. `<input type="file">` and a drop
 * event both yield a `File` too and work everywhere, so a consumer that wants
 * broad support should offer one of those and pass the result to
 * `zipFromBlob` — there is nothing in this package it needs.
 */
export async function pickFile(
  opts: { accept?: Record<string, string[]> } = {},
): Promise<File> {
  const picker = (
    globalThis as {
      showOpenFilePicker?: (o?: {
        multiple?: boolean;
        types?: { description?: string; accept: Record<string, string[]> }[];
      }) => Promise<FileSystemFileHandle[]>;
    }
  ).showOpenFilePicker;
  if (typeof picker !== "function") {
    throw new Error("this browser has no File System Access API");
  }
  const [handle] = await picker({
    multiple: false,
    ...(opts.accept ? { types: [{ accept: opts.accept }] } : {}),
  });
  if (!handle) throw new Error("no file chosen");
  return await handle.getFile();
}

/** Prompt for a zip archive specifically. */
export async function pickArchive(): Promise<File> {
  return await pickFile({ accept: { "application/zip": [".zip"] } });
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

/**
 * Does this error mean "nothing of that kind is there"?
 *
 * Only those two. Everything used to be caught, so after a reload — permission
 * back to `"prompt"`, every call rejecting with `NotAllowedError` — `file()`
 * answered null for every path and the tree looked empty rather than locked.
 * `null` is for absence; a caller who is refused needs to hear it, because
 * the remedy is a button, not a different path.
 */
function isAbsence(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "NotFoundError" || name === "TypeMismatchError";
}

/** A failure to create, with the reason the browser gave. */
function notCreated(path: string, e: unknown): BackendError {
  const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new BackendError(`could not be created (${why})`, path, { cause: e });
}

export interface FsaFileSystemOptions {
  /** Match names without regard to case. Costs a listing per lookup. */
  caseInsensitive?: boolean;
}

/**
 * A handle, and the path it was actually found at.
 *
 * The path is carried rather than recomputed because under `caseInsensitive`
 * the two differ: a caller asking for `/ecu/ms43.prg` gets the handle for
 * `MS43.PRG`, and the name it is *stored* under is the one that has to reach
 * `CsFile.name`. Something downstream cares — BMW's tooling pins a variant by
 * that name, so echoing the caller's own casing back at it is a wrong answer
 * that looks like a right one.
 */
interface Resolved<H> {
  readonly handle: H;
  readonly path: string;
}

export class FsaFileSystem implements WritableFileSystem {
  readonly kind: string = "fsa";
  private readonly dirs = new Map<
    string,
    Promise<Resolved<FileSystemDirectoryHandle> | null>
  >();

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly opts: FsaFileSystemOptions = {},
  ) {
    this.dirs.set("/", Promise.resolve({ handle: root, path: "/" }));
  }

  get name(): string {
    return this.root.name;
  }

  /** The handle, so a consumer can store it for next time. */
  get handle(): FileSystemDirectoryHandle {
    return this.root;
  }

  /**
   * Resolve a directory, optionally creating it. Cached.
   *
   * Every directory resolved on the way is cached, creating or not, and a walk
   * starts from the deepest ancestor already known. `create` used to skip the
   * cache entirely, so each write re-walked every segment — and on a
   * case-insensitive tree each segment is a full listing, which made copying
   * n files into one directory cost about n²/2 entries read.
   */
  private dir(
    path: string,
    create = false,
  ): Promise<Resolved<FileSystemDirectoryHandle> | null> {
    const full = normalizePath(path);
    const hit = this.dirs.get(full);
    if (hit && !create) return hit;
    const promise = (async (): Promise<Resolved<FileSystemDirectoryHandle> | null> => {
      if (hit) {
        const known = await hit;
        if (known) return known;
      }
      const parts = segments(full);
      let current: FileSystemDirectoryHandle = this.root;
      let found: string[] = [];
      let start = 0;
      for (let i = parts.length - 1; i > 0; i--) {
        const ancestor = this.dirs.get(`/${parts.slice(0, i).join("/")}`);
        const known = ancestor ? await ancestor : null;
        if (known) {
          current = known.handle;
          found = segments(known.path);
          start = i;
          break;
        }
      }
      for (let i = start; i < parts.length; i++) {
        const name = parts[i]!;
        /*
         * `findChild` returns null for a directory that is not there yet, and
         * when creating that is the normal case rather than a failure — so it
         * falls back to the name as given, exactly as `fileHandle` does.
         *
         * Without the fallback, `create` could only ever descend into
         * directories that already existed: every write to a nested path
         * failed on a case-insensitive filesystem, and it failed by returning
         * null from `write`, which reads as "could not be created" with no clue
         * that the parent was the problem.
         */
        const resolved = this.opts.caseInsensitive
          ? ((await this.findChild(current, name, "directory")) ?? (create ? name : null))
          : name;
        if (resolved === null) return null;
        try {
          current = await current.getDirectoryHandle(resolved, { create });
        } catch (e) {
          // Creating, a clash with a file of that name is a failure to say
          // out loud, not an absence.
          if (isAbsence(e) && !create) return null;
          if (create) throw notCreated(`/${[...found, resolved].join("/")}`, e);
          throw e;
        }
        found.push(resolved);
        const prefix = `/${parts.slice(0, i + 1).join("/")}`;
        if (i < parts.length - 1 && !this.dirs.has(prefix)) {
          this.dirs.set(
            prefix,
            Promise.resolve({ handle: current, path: `/${found.join("/")}` }),
          );
        }
      }
      return { handle: current, path: `/${found.join("/")}` };
    })();
    // Cached before it settles, so concurrent lookups share one walk rather
    // than racing to create the same directories.
    this.dirs.set(full, promise);
    // A *miss* or a failure is dropped once it settles. `makeDirectory` or
    // `write` can make one wrong, and a cached null then outlives the thing
    // that fixed it — `directory(p)` kept answering null after
    // `makeDirectory(p)` had succeeded. Caching it during the in-flight window
    // is still worth it, since that is what makes concurrent lookups share one
    // walk.
    const drop = (): void => {
      if (this.dirs.get(full) === promise) this.dirs.delete(full);
    };
    promise.then((r) => {
      if (r === null) drop();
    }, drop);
    return promise;
  }

  /**
   * Forget a cached subtree, after something below it was removed.
   *
   * Folded when case-insensitive, because the cache is keyed by the path as
   * *asked for*: `/Ecu` and `/ecu` are two keys resolving to one directory,
   * and dropping only the one spelled like the caller's argument leaves the
   * other pointing at a handle that no longer exists.
   */
  private forget(path: string): void {
    const fold = (s: string): string => (this.opts.caseInsensitive ? s.toLowerCase() : s);
    const target = fold(path);
    const prefix = `${target}/`;
    for (const key of [...this.dirs.keys()]) {
      const folded = fold(key);
      if (folded === target || folded.startsWith(prefix)) this.dirs.delete(key);
    }
  }

  /** Find a child's real name, ignoring case. `null` if there is none. */
  private async findChild(
    dir: FileSystemDirectoryHandle,
    name: string,
    kind: "file" | "directory",
  ): Promise<string | null>;
  /** Find a child of either kind, ignoring case. */
  private async findChild(
    dir: FileSystemDirectoryHandle,
    name: string,
  ): Promise<{ name: string; kind: "file" | "directory" } | null>;
  private async findChild(
    dir: FileSystemDirectoryHandle,
    name: string,
    kind?: "file" | "directory",
  ): Promise<string | { name: string; kind: "file" | "directory" } | null> {
    const target = name.toLowerCase();
    let folded: { name: string; kind: "file" | "directory" } | null = null;
    for await (const [entryName, handle] of (dir as DirectoryHandleWithEntries).entries()) {
      if (kind !== undefined && handle.kind !== kind) continue;
      if (entryName.toLowerCase() !== target) continue;
      // An exact spelling beats the fold, as it does on `http` and `zip`: two
      // names differing only in case are both reachable to a caller who
      // spells one exactly.
      if (entryName === name) {
        return kind === undefined ? { name: entryName, kind: handle.kind } : entryName;
      }
      folded ??= { name: entryName, kind: handle.kind };
    }
    if (!folded) return null;
    return kind === undefined ? folded : folded.name;
  }

  private async fileHandle(
    path: string,
    create = false,
  ): Promise<Resolved<FileSystemFileHandle> | null> {
    const full = normalizePath(path);
    const name = basename(full);
    if (name === "") return null;
    const parent = await this.dir(full.slice(0, full.length - name.length), create);
    if (!parent) return null;
    const resolved = this.opts.caseInsensitive
      ? ((await this.findChild(parent.handle, name, "file")) ?? (create ? name : null))
      : name;
    if (resolved === null) return null;
    try {
      const handle = await parent.handle.getFileHandle(resolved, { create });
      return { handle, path: joinPath(parent.path, resolved) };
    } catch (e) {
      if (create) throw notCreated(joinPath(parent.path, resolved), e);
      if (isAbsence(e)) return null;
      throw e;
    }
  }

  async file(path: string): Promise<CsFile | null> {
    const found = await this.fileHandle(path);
    if (!found) return null;
    try {
      // A `File` *is* a `Blob`, which is what makes slicing a 945 MB archive
      // read only the slice.
      const file = (await found.handle.getFile()) as unknown as BlobLike;
      // `found.path`, not the argument: the name a caller gets back is the one
      // the directory stores.
      return new BlobFile(found.path, file, mimeType(found.path));
    } catch (e) {
      // Removed between the lookup and the read.
      if (isAbsence(e)) return null;
      throw e;
    }
  }

  async directory(path: string): Promise<CsDirectory | null> {
    const found = await this.dir(path);
    return found ? new FsaDirectory(this, found.handle, found.path) : null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return (await this.file(path))?.bytes() ?? null;
  }

  async stat(path: string): Promise<CsStat | null> {
    const full = normalizePath(path);
    // `""`, as every other backend names its root. The picked directory's own
    // name is `name`, for a consumer that wants to show it.
    if (segments(full).length === 0) return { kind: "directory", name: "", size: 0 };
    const name = basename(full);
    const parent = await this.dir(full.slice(0, full.length - name.length));
    if (!parent) return null;
    // One listing for either kind, where `file()` then `dir()` read the parent
    // twice for every directory on a case-insensitive tree.
    const child = this.opts.caseInsensitive
      ? await this.findChild(parent.handle, name)
      : { name, kind: undefined };
    if (!child) return null;
    if (child.kind !== "directory") {
      try {
        const handle = await parent.handle.getFileHandle(child.name);
        const file = await handle.getFile();
        return { kind: "file", name: child.name, size: file.size };
      } catch (e) {
        if (!isAbsence(e)) throw e;
        if (child.kind === "file") return null;
      }
    }
    const dir = await this.dir(joinPath(parent.path, child.name));
    return dir ? { kind: "directory", name: basename(dir.path), size: 0 } : null;
  }

  async write(path: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    const found = await this.fileHandle(path, true);
    // Not reached for a failure the browser explained — that is thrown with
    // its reason — only for a path with no name to create.
    if (!found) throw new BackendError("could not be created (not a file path)", path);
    const handle = found.handle;
    // `createWritable` stages into a temporary file and swaps on close, so a
    // crash mid-write leaves the previous content rather than a truncated
    // file. The cost is that write traffic roughly doubles. OPFS has
    // `createSyncAccessHandle` to avoid that, inside a worker only, and this
    // backend does not use it.
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
    if (!(await this.dir(path, true))) throw new BackendError("could not be created", path);
  }

  async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const full = normalizePath(path);
    const name = basename(full);
    // The root has no parent to be removed from, and `removeEntry("")` throws
    // something unhelpful rather than saying so. Refused rather than ignored,
    // as on every backend: `node` used to delete the root itself.
    if (name === "") throw new UnsupportedOperationError("remove the root", this.kind);
    const parent = await this.dir(full.slice(0, full.length - name.length));
    // Absent already, which is what was asked for.
    if (!parent) return;
    // `removeEntry` takes a literal name, so a case-insensitive filesystem has
    // to resolve it first — otherwise `remove("/ecu/ms43.prg")` silently fails
    // to remove `MS43.PRG`, the one case this option exists to handle. A file
    // is tried before a directory because it is the commoner request; the
    // fallback to `name` lets the API's own NotFoundError be the error.
    const resolved = this.opts.caseInsensitive
      ? ((await this.findChild(parent.handle, name, "file")) ??
        (await this.findChild(parent.handle, name, "directory")) ??
        name)
      : name;
    try {
      await (
        parent.handle as FileSystemDirectoryHandle & {
          removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
        }
      ).removeEntry(resolved, { recursive: opts.recursive ?? false });
    } catch (e) {
      if ((e as { name?: unknown } | null)?.name !== "NotFoundError") throw e;
    }
    this.forget(full);
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
        // `buildManifest` does exactly that when a size is wanted.
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
