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
  dirname,
  formatPath,
  normalizePath,
  parsePath,
  statVia,
  type CsDirectory,
  type CsEntry,
  type CsFile,
  type CsFileSystem,
  type CsStat,
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

/**
 * Resolve `#` fragments through archives.
 *
 * Read-only, and it adds no behaviour to paths without a `#` — so wrapping a
 * file system costs nothing until someone uses the syntax.
 */
export function withArchives(fs: CsFileSystem, opts?: ZipFileSystemOptions): CsFileSystem {
  const cache = new Map<string, Promise<ZipFileSystem | null>>();

  const mount = (path: string): Promise<ZipFileSystem | null> => {
    const hit = cache.get(path);
    if (hit) return hit;
    // Cached as the promise, so two concurrent lookups share one read of the
    // central directory rather than both fetching it.
    const promise = (async () => {
      const file = await resolve(path);
      return file ? zipFileSystem(file, opts) : null;
    })();
    cache.set(path, promise);
    return promise;
  };

  /** Resolve a possibly-nested path down to the file it names. */
  async function resolve(path: string): Promise<CsFile | null> {
    const { base, fragments } = parsePath(path);
    if (fragments.length === 0) return await fs.file(base);
    let container = base;
    for (let i = 0; i < fragments.length; i++) {
      const inner = fragments[i]!;
      const archive = await mount(container);
      if (!archive) return null;
      if (i === fragments.length - 1) return await archive.file(inner);
      // Not the last hop: this fragment names another archive, so it becomes
      // the container for the next one.
      container = `${container}#${inner}`;
    }
    return null;
  }

  return {
    kind: `${fs.kind}+zip`,

    async file(path) {
      return await resolve(path);
    },

    async directory(path) {
      const { base, fragments } = parsePath(path);
      if (fragments.length === 0) return await fs.directory(base);
      let container = base;
      for (let i = 0; i < fragments.length - 1; i++) {
        container = `${container}#${fragments[i]!}`;
      }
      const archive = await mount(container);
      return archive ? await archive.directory(fragments[fragments.length - 1]!) : null;
    },

    async read(path) {
      return (await resolve(path))?.bytes() ?? null;
    },

    async stat(path) {
      const { base, fragments } = parsePath(path);
      if (fragments.length === 0) return await fs.stat(base);
      let container = base;
      for (let i = 0; i < fragments.length - 1; i++) {
        container = `${container}#${fragments[i]!}`;
      }
      const archive = await mount(container);
      return archive ? await archive.stat(fragments[fragments.length - 1]!) : null;
    },
  };
}

/**
 * Make archives answer for directories, per a declared mapping.
 *
 * A real file always wins: a tree that was extracted keeps working, and a
 * half-extracted one falls back file by file rather than failing. Except for
 * *listing* — a directory that exists only inside an archive has no real
 * counterpart to list, so both are merged.
 */
export function withTransparentArchives(
  fs: CsFileSystem,
  mounts: readonly ArchiveMount[],
  opts?: ZipFileSystemOptions,
): CsFileSystem {
  const normalized = mounts.map((m) => ({
    archive: normalizePath(m.archive),
    serves: normalizePath(m.serves),
    entry: m.entry ?? "relative",
  }));
  const cache = new Map<string, Promise<ZipFileSystem | null>>();

  const mount = (archive: string): Promise<ZipFileSystem | null> => {
    const hit = cache.get(archive);
    if (hit) return hit;
    const promise = (async () => {
      const file = await fs.file(archive);
      return file ? zipFileSystem(file, opts) : null;
    })();
    cache.set(archive, promise);
    return promise;
  };

  /** Every mount that could answer for this path. */
  function candidates(path: string): { archive: string; inner: string }[] {
    const p = normalizePath(path);
    const out: { archive: string; inner: string }[] = [];
    for (const m of normalized) {
      if (p !== m.serves && !p.startsWith(`${m.serves}/`)) continue;
      // Plural on purpose: several archives can stand in for one directory,
      // which is how a data set that ships `images_1.zip` on three discs is
      // read without renaming its contents.
      const inner =
        m.entry === "basename" ? `/${basename(p)}` : p.slice(m.serves.length) || "/";
      out.push({ archive: m.archive, inner });
    }
    return out;
  }

  async function fromArchives(path: string): Promise<CsFile | null> {
    for (const { archive, inner } of candidates(path)) {
      const zip = await mount(archive);
      const found = await zip?.file(inner);
      if (found) return found;
    }
    return null;
  }

  return {
    kind: `${fs.kind}+mounted-zip`,

    async file(path) {
      return (await fs.file(path)) ?? (await fromArchives(path));
    },

    async read(path) {
      return (await this.file(path))?.bytes() ?? null;
    },

    async directory(path) {
      const real = await fs.directory(path);
      const mounted = candidates(path);
      if (mounted.length === 0) return real;

      const inners: CsDirectory[] = [];
      for (const { archive, inner } of mounted) {
        // A `basename` mount has no directory structure to contribute: its
        // entries are flat and its shape says nothing about the tree it stands
        // in for, so listing it would invent paths that do not resolve.
        const m = normalized.find((n) => n.archive === archive);
        if (m?.entry === "basename") continue;
        const zip = await mount(archive);
        const dir = await zip?.directory(inner);
        if (dir) inners.push(dir);
      }
      if (!real && inners.length === 0) return null;
      return new MergedDirectory(normalizePath(path), real, inners, this);
    },

    async stat(path) {
      const direct = await fs.stat(path);
      if (direct) return direct;
      const file = await fromArchives(path);
      if (file) return { kind: "file", name: basename(path), size: file.size };
      const dir = await this.directory(path);
      return dir ? { kind: "directory", name: basename(path), size: 0 } : null;
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
    private readonly owner: CsFileSystem,
  ) {
    this.name = basename(path);
  }

  async entries(): Promise<CsEntry[]> {
    const byName = new Map<string, CsEntry>();
    // Real files first, so an extracted copy wins over an archived one and the
    // sizes reported are the ones on disk.
    for (const source of [this.real, ...this.inners]) {
      if (!source) continue;
      for (const e of await source.entries()) {
        if (!byName.has(e.name)) byName.set(e.name, e);
      }
    }
    return [...byName.values()];
  }

  async file(name: string): Promise<CsFile | null> {
    return await this.owner.file(`${this.path}/${name}`);
  }

  async directory(name: string): Promise<CsDirectory | null> {
    return await this.owner.directory(`${this.path}/${name}`);
  }
}

/** Re-exported for callers building paths. */
export { formatPath, dirname, statVia };
