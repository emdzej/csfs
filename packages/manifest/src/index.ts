/**
 * The manifest, and how to build one.
 *
 * **HTTP cannot list a directory.** That is the whole reason this exists: a
 * static host will serve any file you name and tell you nothing about what is
 * there. So a tree served over HTTP carries a description of itself, and every
 * `entries()` call reads from that rather than from the network.
 *
 * The format is a flat map from path to size, not a nested tree. Three reasons,
 * all learned by trying the alternatives:
 *
 * - **It compresses well.** Paths in a real tree share long prefixes. Measured:
 *   43,915 entries come to 4.02 MB of JSON and 0.42 MB gzipped — not the
 *   "few hundred kilobytes" first guessed here, but 9.4:1 and a one-off cost
 *   when the tree is opened.
 * - **A lookup is one map hit**, with no walk and no per-directory fetch. A
 *   per-directory index — one `index.json` in every folder — costs a round trip
 *   per level, which is four or five before you reach a file.
 * - **Directories are derived**, so an archive mounted over a directory that
 *   does not exist on disk still lists correctly.
 *
 * The cost is that the whole manifest is fetched up front. For 228,000 entries
 * that is worth it; for a tree of a dozen files either shape is fine.
 */
import {
  basename,
  dirname,
  normalizePath,
  walkFileSystem,
  type CsFileSystem,
} from "@emdzej/csfs-core";

/** Bump when the shape changes in a way an old reader cannot handle. */
export const MANIFEST_VERSION = 1;

/** Where a reader looks for it, unless told otherwise. */
export const MANIFEST_FILE = "csfs-manifest.json";

export interface ManifestArchive {
  /** Path of the archive within the tree. */
  archive: string;
  /** The directory it answers for. */
  serves: string;
  /** How a requested path becomes an entry name. Default `"relative"`. */
  entry?: "relative" | "basename";
}

export interface Manifest {
  csfs: typeof MANIFEST_VERSION;
  /** ISO-8601. Supplied by the builder's caller, never invented here. */
  builtAt?: string;
  /** Free-form label, so a tree can say what it is. */
  label?: string;
  /**
   * Path to size, in bytes. Paths are rooted and normalised.
   *
   * Only files. Directories are inferred, because a tree where an archive
   * stands in for a directory has no real directory to record.
   */
  files: Record<string, number>;
  /** Archives to read in place rather than expecting them unpacked. */
  archives?: ManifestArchive[];
}

export interface BuildManifestOptions {
  /** Where to start. Default: the root. */
  root?: string;
  /** Skip a file or a whole subtree. */
  filter?: (path: string, size: number) => boolean;
  label?: string;
  /** ISO-8601 timestamp. Omitted when absent — a builder should not guess. */
  builtAt?: string;
  archives?: ManifestArchive[];
  /** Called as the walk proceeds, for progress in a long build. */
  onProgress?: (found: number, path: string) => void;
}

/**
 * Walk a file system and describe it.
 *
 * Works against any backend, which is the point: the CLI builds a manifest
 * from `node:fs` and the web app builds one from a directory the user picked,
 * and both call this.
 */
export async function buildManifest(
  fs: CsFileSystem,
  opts: BuildManifestOptions = {},
): Promise<Manifest> {
  const files: Record<string, number> = {};
  let found = 0;
  for await (const entry of walkFileSystem(fs, opts.root ?? "/")) {
    if (entry.kind !== "file") continue;
    if (opts.filter && !opts.filter(entry.path, entry.size)) continue;
    // The size may be 0 from a listing that does not report it; ask the file.
    let size = entry.size;
    if (size === 0) size = (await fs.file(entry.path))?.size ?? 0;
    files[normalizePath(entry.path)] = size;
    found += 1;
    opts.onProgress?.(found, entry.path);
  }
  return {
    csfs: MANIFEST_VERSION,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.builtAt !== undefined ? { builtAt: opts.builtAt } : {}),
    files,
    ...(opts.archives && opts.archives.length > 0 ? { archives: opts.archives } : {}),
  };
}

/** Validate an unknown value as a manifest, or explain why it is not one. */
export function parseManifest(value: unknown): Manifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("manifest is not an object");
  }
  const m = value as Partial<Manifest>;
  if (m.csfs !== MANIFEST_VERSION) {
    // Named rather than ignored: a future version may reorganise `files`, and
    // reading it as this one would produce a tree that is subtly wrong instead
    // of one that fails.
    throw new Error(`manifest version ${String(m.csfs)} is not supported (expected 1)`);
  }
  if (typeof m.files !== "object" || m.files === null) {
    throw new Error("manifest has no files map");
  }
  return m as Manifest;
}

/** Serialise, with the file map sorted so the output is reproducible. */
export function formatManifest(manifest: Manifest, opts: { pretty?: boolean } = {}): string {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(manifest.files).sort()) sorted[key] = manifest.files[key]!;
  const ordered: Manifest = { ...manifest, files: sorted };
  return JSON.stringify(ordered, null, opts.pretty ? 2 : 0) + "\n";
}

/**
 * A manifest indexed for lookups.
 *
 * Built once from the flat map: a set of directories, and each directory's
 * children. Directories are *derived* from file paths, so a path only an
 * archive can answer for still appears in a listing.
 */
export class ManifestIndex {
  private readonly files: Map<string, number>;
  private readonly children = new Map<string, Map<string, number | null>>();

  constructor(readonly manifest: Manifest) {
    this.files = new Map(Object.entries(manifest.files));
    for (const path of this.files.keys()) {
      let child = path;
      let parent = dirname(path);
      for (;;) {
        const bucket = this.children.get(parent) ?? new Map<string, number | null>();
        const name = basename(child);
        // `null` marks a directory, a number a file with that size.
        if (!bucket.has(name)) {
          bucket.set(name, child === path ? (this.files.get(path) ?? 0) : null);
        }
        this.children.set(parent, bucket);
        if (parent === "/") break;
        child = parent;
        parent = dirname(parent);
      }
    }
    // Archives that stand in for a directory make that directory exist even
    // when no file inside it is listed. It has to be linked into its parents
    // as well as given a bucket of its own — registering only the bucket made
    // the directory resolvable but invisible in its parent's listing, which is
    // the sort of half-existence that is worse than absence.
    for (const a of manifest.archives ?? []) {
      this.addDirectory(normalizePath(a.serves));
    }
  }

  /** Record a directory, and every parent up to the root. */
  private addDirectory(path: string): void {
    if (!this.children.has(path)) this.children.set(path, new Map());
    let child = path;
    while (child !== "/") {
      const parent = dirname(child);
      const bucket = this.children.get(parent) ?? new Map<string, number | null>();
      if (!bucket.has(basename(child))) bucket.set(basename(child), null);
      this.children.set(parent, bucket);
      child = parent;
    }
  }

  size(path: string): number | undefined {
    return this.files.get(normalizePath(path));
  }

  hasFile(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  hasDirectory(path: string): boolean {
    return this.children.has(normalizePath(path));
  }

  /** Direct children of a directory: name to size, or `null` for a directory. */
  entriesOf(path: string): Map<string, number | null> {
    return this.children.get(normalizePath(path)) ?? new Map();
  }

  get fileCount(): number {
    return this.files.size;
  }

  get totalBytes(): number {
    let total = 0;
    for (const size of this.files.values()) total += size;
    return total;
  }
}
