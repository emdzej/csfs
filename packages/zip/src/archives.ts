/**
 * Archives as part of the surrounding file system.
 *
 * Two ways in, because they answer different questions:
 *
 * **`withArchives(fs)`** makes `#` work. `/dessins/100.zip#/1132C000.png`
 * resolves through the archive, and so does `/a.zip#/b.zip#/deep.txt`. The
 * caller has to know the archive is there, which is the honest case when a
 * path comes from a manifest or a link.
 *
 * **`withTransparentArchives(fs, mounts)`** makes an archive answer for a
 * directory that does not exist. A tree may ship `dessins/100.zip` while every
 * reference in the data says `dessins/100/1132/1132C000.png` — the archive and
 * the extracted layout are *different shapes*, and only the tree's author
 * knows how one maps onto the other. So a mount states it rather than guessing.
 *
 * Mounted archives are opened once and cached, because the expensive part is
 * the central directory, not the reads.
 */
import {
  basename,
  normalizePath,
  parsePath,
  segments,
  type CsDirectory,
  type CsEntry,
  type CsFile,
  type CsFileSystem,
  type CsStat,
  type ReadOptions,
} from "@emdzej/csfs-core";
import { ZipFileSystem, zipFileSystem, type ZipFileSystemOptions } from "./zip-fs.js";

/** Which archive stands in for which directory, and how names map. */
export interface ArchiveMount {
  /** Path of the archive within the host file system. */
  readonly archive: string;
  /** The directory it answers for. */
  readonly serves: string;
  /**
   * How to turn a requested path into an entry name.
   *
   * `"relative"` strips `serves` — the usual case, where the archive mirrors
   * the directory. `"basename"` uses only the last segment, for a flat archive
   * standing in for a nested tree; that is not a corner case, it is how parts
   * catalogues ship their drawings.
   */
  readonly entry?: "relative" | "basename";
}

/** Join a child onto a directory path, including an archive root like `/a.zip#/`. */
function join(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * A file reporting the path it was reached by.
 *
 * A zip answers with paths inside itself, which is right for the zip and wrong
 * for anything that wraps it: `CsFile.path` is documented as the full path,
 * archive fragment included, so `file("/d.zip#/sub/y.txt").path` came back as
 * `/sub/y.txt` — a key that reaches a different file, or none, when a caller
 * caches by it or opens it again.
 */
class PathedFile implements CsFile {
  readonly name: string;

  constructor(
    private readonly inner: CsFile,
    readonly path: string,
  ) {
    this.name = basename(path.split("#").at(-1) ?? path);
  }

  get size(): number {
    return this.inner.size;
  }

  get type(): string {
    return this.inner.type;
  }

  slice(start?: number, end?: number): CsFile {
    return new PathedFile(this.inner.slice(start, end), this.path);
  }

  arrayBuffer(opts?: ReadOptions): Promise<ArrayBuffer> {
    return this.inner.arrayBuffer(opts);
  }

  bytes(opts?: ReadOptions): Promise<Uint8Array> {
    return this.inner.bytes(opts);
  }

  stream(): ReadableStream<Uint8Array> {
    return this.inner.stream();
  }

  text(opts?: ReadOptions): Promise<string> {
    return this.inner.text(opts);
  }
}

/** A directory inside an archive, reporting — and handing out — full paths. */
class PathedDirectory implements CsDirectory {
  readonly name: string;

  constructor(
    private readonly inner: CsDirectory,
    readonly path: string,
  ) {
    this.name = basename(path.split("#").at(-1) ?? path);
  }

  entries(): Promise<CsEntry[]> {
    return this.inner.entries();
  }

  async file(name: string): Promise<CsFile | null> {
    const found = await this.inner.file(name);
    return found ? new PathedFile(found, join(this.path, found.name)) : null;
  }

  async directory(name: string): Promise<CsDirectory | null> {
    const found = await this.inner.directory(name);
    return found ? new PathedDirectory(found, join(this.path, found.name)) : null;
  }
}

/** An opened archive, and the path its own file answered with. */
interface Opened {
  readonly zip: ZipFileSystem;
  readonly path: string;
}

/**
 * Open archives once, sharing the promise between concurrent lookups.
 *
 * Only a success is kept. An absent archive may yet be written, and a failed
 * read — a dropped connection while fetching the central directory — would
 * otherwise have made every later lookup through it fail, long after the
 * network had come back.
 */
function archiveCache(
  open: (path: string) => Promise<CsFile | null>,
  opts: ZipFileSystemOptions | undefined,
): (path: string) => Promise<Opened | null> {
  const cache = new Map<string, Promise<Opened | null>>();
  return (path) => {
    const hit = cache.get(path);
    if (hit) return hit;
    // Cached as the promise, so two concurrent lookups share one read of the
    // central directory rather than both fetching it.
    const promise = (async () => {
      const file = await open(path);
      if (!file) return null;
      const zip = zipFileSystem(file, opts);
      // Opened here rather than on first use, so that an archive that cannot be
      // read is not kept as though it could.
      await zip.names();
      return { zip, path: file.path };
    })();
    cache.set(path, promise);
    promise.then(
      (opened) => {
        if (!opened) cache.delete(path);
      },
      () => cache.delete(path),
    );
    return promise;
  };
}

/**
 * Resolve `#` fragments through archives.
 *
 * Read-only, and it adds no behaviour to paths without a `#` — so wrapping a
 * file system costs nothing until someone uses the syntax. What it hands back
 * carries the full path, container and all, as the archive stores it.
 */
export function withArchives(fs: CsFileSystem, opts?: ZipFileSystemOptions): CsFileSystem {
  const mount = archiveCache((path) => resolve(path), opts);

  /** The archive a path's last fragment is inside. */
  async function container(base: string, fragments: readonly string[]): Promise<Opened | null> {
    let path = base;
    for (let i = 0; i < fragments.length - 1; i++) path = `${path}#${fragments[i]!}`;
    return await mount(path);
  }

  /** Resolve a possibly-nested path down to the file it names. */
  async function resolve(path: string): Promise<CsFile | null> {
    const { base, fragments } = parsePath(path);
    if (fragments.length === 0) return await fs.file(base);
    const opened = await container(base, fragments);
    const found = await opened?.zip.file(fragments[fragments.length - 1]!);
    return found && opened ? new PathedFile(found, `${opened.path}#${found.path}`) : null;
  }

  return {
    kind: `${fs.kind}+zip`,

    async file(path) {
      return await resolve(path);
    },

    async directory(path) {
      const { base, fragments } = parsePath(path);
      if (fragments.length === 0) return await fs.directory(base);
      const opened = await container(base, fragments);
      const found = await opened?.zip.directory(fragments[fragments.length - 1]!);
      return found && opened
        ? new PathedDirectory(found, `${opened.path}#${found.path}`)
        : null;
    },

    async read(path, opts) {
      return (await resolve(path))?.bytes(opts) ?? null;
    },

    async stat(path) {
      const { base, fragments } = parsePath(path);
      if (fragments.length === 0) return await fs.stat(base);
      const opened = await container(base, fragments);
      return (await opened?.zip.stat(fragments[fragments.length - 1]!)) ?? null;
    },

    async directUrl(path) {
      const { fragments } = parsePath(path);
      // An entry inside an archive has no URL of its own: the bytes are
      // compressed inside a larger file, so handing back the archive's URL
      // would load the wrong thing entirely.
      if (fragments.length > 0) return null;
      return (await fs.directUrl?.(path)) ?? null;
    },
  };
}

/** A mount that matched a path, and where in the archive to look. */
interface Candidate {
  readonly archive: string;
  readonly entry: "relative" | "basename";
  /** Entry path inside the archive. */
  readonly inner: string;
  /**
   * The path outside the archive that the inner path hangs off: `serves` for a
   * relative mount, the requested directory for a flat one. A result's full
   * path is this plus the name the archive stores.
   */
  readonly outer: string;
}

/**
 * Make archives answer for directories, per a declared mapping.
 *
 * A real file always wins: a tree that was extracted keeps working, and a
 * half-extracted one falls back file by file rather than failing. Except for
 * *listing* — a directory that exists only inside an archive has no real
 * counterpart to list, so both are merged.
 *
 * `opts.caseInsensitive` applies to matching a path against `serves` as well
 * as to the entries inside the archive; half of it was a lookup that folded
 * inside the zip and missed on the way in.
 */
export function withTransparentArchives(
  fs: CsFileSystem,
  mounts: readonly ArchiveMount[],
  opts?: ZipFileSystemOptions,
): CsFileSystem {
  const insensitive = opts?.caseInsensitive ?? false;
  const fold = (s: string): string => (insensitive ? s.toLowerCase() : s);
  const normalized = mounts.map((m) => ({
    archive: normalizePath(m.archive),
    serves: normalizePath(m.serves),
    servesParts: segments(m.serves),
    entry: m.entry ?? "relative",
  }));
  const mount = archiveCache((archive) => fs.file(archive), opts);

  /**
   * Every mount that could answer for this path.
   *
   * Compared segment by segment rather than by string prefix: `serves: "/"`
   * made the prefix `"//"`, which no path starts with, so a mount at the root
   * never answered anything.
   */
  function candidates(path: string): Candidate[] {
    const parts = segments(path);
    const out: Candidate[] = [];
    for (const m of normalized) {
      const n = m.servesParts.length;
      if (parts.length < n) continue;
      if (!m.servesParts.every((s, i) => fold(s) === fold(parts[i]!))) continue;
      const rest = parts.slice(n);
      // Plural on purpose: several archives can stand in for one directory,
      // which is how a data set that ships `images_1.zip` on three discs is
      // read without renaming its contents.
      if (m.entry === "basename") {
        // A flat mount's intermediate directories exist only in the caller's
        // path, so the caller's spelling of them is the only one there is.
        const outer = `/${parts.slice(0, -1).join("/")}`;
        out.push({
          archive: m.archive,
          entry: m.entry,
          inner: `/${parts.at(-1) ?? ""}`,
          outer,
        });
      } else {
        out.push({
          archive: m.archive,
          entry: m.entry,
          inner: `/${rest.join("/")}`,
          outer: m.serves,
        });
      }
    }
    return out;
  }

  /** Where an entry the archive found at `stored` lives in the host tree. */
  const outside = (c: Candidate, stored: string): string =>
    c.entry === "basename"
      ? join(c.outer, basename(stored))
      : normalizePath(`${c.outer}${stored}`);

  async function fromArchives(path: string): Promise<CsFile | null> {
    for (const c of candidates(path)) {
      const found = await (await mount(c.archive))?.zip.file(c.inner);
      if (found) return new PathedFile(found, outside(c, found.path));
    }
    return null;
  }

  /**
   * Children a mount adds to a directory by being declared beneath it.
   *
   * A mount at `/a/b` makes `/a` exist and list `b`, whether or not the host
   * has either. Leaving that out repeated the manifest's mistake: `/a/b/x` was
   * readable while `directory("/a")` was null and `/` did not list `a`. `http`
   * hid it, because its manifest derives the parents; `node`, `fsa` and `opfs`
   * do not.
   */
  function declaredChildren(path: string): Map<string, string> {
    const parts = segments(path);
    const out = new Map<string, string>();
    for (const m of normalized) {
      if (m.servesParts.length <= parts.length) continue;
      if (!parts.every((s, i) => fold(s) === fold(m.servesParts[i]!))) continue;
      const name = m.servesParts[parts.length]!;
      if (!out.has(fold(name))) out.set(fold(name), name);
    }
    return out;
  }

  /** Is this path exactly a mount's `serves`? A declared directory exists. */
  const isServed = (path: string): boolean => {
    const parts = segments(path);
    return normalized.some(
      (m) =>
        m.servesParts.length === parts.length &&
        m.servesParts.every((s, i) => fold(s) === fold(parts[i]!)),
    );
  };

  return {
    kind: `${fs.kind}+mounted-zip`,

    async file(path) {
      return (await fs.file(path)) ?? (await fromArchives(path));
    },

    async read(path, opts) {
      return (await this.file(path))?.bytes(opts) ?? null;
    },

    async directory(path) {
      const real = await fs.directory(path);
      const mounted = candidates(path);
      const declared = declaredChildren(path);
      if (mounted.length === 0 && declared.size === 0) return real;

      const inners: { dir: CsDirectory; path: string }[] = [];
      for (const c of mounted) {
        // A `basename` mount has no directory structure to contribute: its
        // entries are flat and its shape says nothing about the tree it stands
        // in for, so listing it would invent paths that do not resolve.
        if (c.entry === "basename") continue;
        const dir = await (await mount(c.archive))?.zip.directory(c.inner);
        if (dir) inners.push({ dir, path: outside(c, dir.path) });
      }
      if (!real && inners.length === 0 && declared.size === 0 && !isServed(path)) return null;
      // The name as stored: the host's if it has the directory, the archive's
      // if only the archive does, and the caller's only when neither records it.
      const canonical = real?.path ?? inners[0]?.path ?? normalizePath(path);
      return new MergedDirectory(
        canonical,
        real,
        inners.map((i) => i.dir),
        [...declared.values()],
        fold,
        this,
      );
    },

    async stat(path) {
      const direct = await fs.stat(path);
      if (direct) return direct;
      // Straight to the archive's own `stat`, which reads the central
      // directory's size and the stored name. Going through `file()` inflated
      // the whole entry to learn its length, and echoed the caller's spelling.
      for (const c of candidates(path)) {
        const found = await (await mount(c.archive))?.zip.stat(c.inner);
        if (found?.kind === "file") return found;
      }
      const dir = await this.directory(path);
      return dir ? { kind: "directory", name: dir.name, size: 0 } : null;
    },

    async directUrl(path) {
      /*
       * Only for a file that really exists.
       *
       * The inner backend decides, and its answer is already the right one:
       * `HttpFileSystem.directUrl` returns null for a path its manifest does
       * not list. So a path that only a mounted archive can serve gets null
       * here and the caller falls back to a blob — which is correct, because
       * the bytes are inside a zip and no URL addresses them.
       *
       * Asking the inner backend rather than checking `file()` first also
       * keeps this to one lookup, and keeps "is there a real file" a question
       * only the backend answers.
       */
      return (await fs.directUrl?.(path)) ?? null;
    },
  };
}

/** A directory whose children come from the real tree and from archives. */
class MergedDirectory implements CsDirectory {
  readonly name: string;

  constructor(
    readonly path: string,
    private readonly real: CsDirectory | null,
    private readonly inners: readonly CsDirectory[],
    /** Directories that exist because a mount is declared beneath this one. */
    private readonly declared: readonly string[],
    private readonly fold: (name: string) => string,
    private readonly owner: CsFileSystem,
  ) {
    this.name = basename(path);
  }

  async entries(): Promise<CsEntry[]> {
    const byName = new Map<string, CsEntry>();
    // Real files first, so an extracted copy wins over an archived one and the
    // sizes reported are the ones on disk. Keyed by the folded name when the
    // mount is case-insensitive: `Foo.png` on disk and `foo.png` archived are
    // one entry, since both resolve to the real one.
    for (const source of [this.real, ...this.inners]) {
      if (!source) continue;
      for (const e of await source.entries()) {
        if (!byName.has(this.fold(e.name))) byName.set(this.fold(e.name), e);
      }
    }
    for (const name of this.declared) {
      if (!byName.has(this.fold(name)))
        byName.set(this.fold(name), { kind: "directory", name });
    }
    return [...byName.values()];
  }

  async file(name: string): Promise<CsFile | null> {
    return await this.owner.file(join(this.path, name));
  }

  async directory(name: string): Promise<CsDirectory | null> {
    return await this.owner.directory(join(this.path, name));
  }
}
