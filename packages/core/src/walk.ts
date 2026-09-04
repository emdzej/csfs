/**
 * Walking a tree, and resolving a path through it.
 *
 * Every backend needs the same two things: turn `/a/b/c.txt` into a sequence
 * of lookups, and enumerate a tree depth-first. Both are written once here,
 * against the interface, so a backend supplies only `entries`, `file` and
 * `directory` on a single directory.
 */
import { basename, dirname, segments } from "./path.js";
import type { CsDirectory, CsEntry, CsFile, CsFileSystem, CsStat } from "./types.js";

/** Walk down from a directory to the one at `path`. `null` if absent. */
export async function resolveDirectory(
  root: CsDirectory,
  path: string,
): Promise<CsDirectory | null> {
  let current: CsDirectory | null = root;
  for (const name of segments(path)) {
    if (!current) return null;
    current = await current.directory(name);
  }
  return current;
}

/** Walk down to the file at `path`. `null` if absent or a directory. */
export async function resolveFile(root: CsDirectory, path: string): Promise<CsFile | null> {
  const parent = await resolveDirectory(root, dirname(path));
  if (!parent) return null;
  const name = basename(path);
  if (name === "") return null;
  return await parent.file(name);
}

/**
 * `stat` built from `entries`.
 *
 * Asks the parent for its listing rather than trying the file and then the
 * directory: one round trip instead of two, which matters on a backend where
 * each is a network request.
 */
export async function statVia(root: CsDirectory, path: string): Promise<CsStat | null> {
  const name = basename(path);
  if (name === "") return { kind: "directory", name: "", size: 0 };
  const parent = await resolveDirectory(root, dirname(path));
  if (!parent) return null;
  const found = (await parent.entries()).find((e) => e.name === name);
  if (!found) return null;
  return found.kind === "file"
    ? { kind: "file", name: found.name, size: found.size }
    : { kind: "directory", name: found.name, size: 0 };
}

export interface WalkEntry {
  /** Path from the walk's root, with a leading slash. */
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  /** `0` for directories, and for backends that do not report it in a listing. */
  readonly size: number;
}

export interface WalkOptions {
  /** Skip a subtree, or a file, by returning `false`. */
  filter?: (entry: WalkEntry) => boolean;
  /** Yield directories as well as files. Default: files only. */
  includeDirectories?: boolean;
}

/**
 * Every file under a directory, depth-first.
 *
 * A generator rather than an array: a tree can hold 228,000 files, and a
 * caller that wants a count, or the first match, should not pay for the rest.
 */
export async function* walk(
  dir: CsDirectory,
  opts: WalkOptions = {},
  prefix = "",
): AsyncGenerator<WalkEntry> {
  let listing: CsEntry[];
  try {
    listing = await dir.entries();
  } catch {
    // An unreadable directory ends that branch rather than the whole walk:
    // one permission-denied subtree should not lose the other 200,000 files.
    return;
  }

  for (const child of listing) {
    const path = `${prefix}/${child.name}`;
    const entry: WalkEntry =
      child.kind === "file"
        ? { path, name: child.name, kind: "file", size: child.size }
        : { path, name: child.name, kind: "directory", size: 0 };

    if (opts.filter && !opts.filter(entry)) continue;

    if (child.kind === "directory") {
      if (opts.includeDirectories) yield entry;
      const sub = await dir.directory(child.name);
      if (sub) yield* walk(sub, opts, path);
    } else {
      yield entry;
    }
  }
}

/** `walk` from a filesystem's root. */
export async function* walkFileSystem(
  fs: CsFileSystem,
  path = "/",
  opts: WalkOptions = {},
): AsyncGenerator<WalkEntry> {
  const dir = await fs.directory(path);
  if (!dir) return;
  yield* walk(dir, opts, path === "/" ? "" : path.replace(/\/$/, ""));
}
