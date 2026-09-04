/**
 * The contract every backend implements.
 *
 * Two design decisions shape all of this, and both are worth stating because
 * the obvious alternatives are worse.
 *
 * **A file is modelled on `Blob`, not on `readFile`.** `size`, `slice`,
 * `arrayBuffer`, `stream`, `text` — the same five things a `Blob` gives you.
 * That is not imitation for its own sake: reading *part* of a file is the
 * operation that makes remote data usable at all. An archive is read from its
 * end, a sorted index is binary-searched, a media file is seeked. An interface
 * whose only read is "give me the whole thing" forces a download per lookup,
 * and every backend then grows its own private range API. Because `Blob` and
 * `File` already satisfy this shape, the local backends need no adapter at all.
 *
 * **Reads only.** Writing is a separate, optional interface
 * (`WritableFileSystem`), because two of the three backends cannot write and a
 * combined interface would make every consumer check capabilities it does not
 * use. A read-only filesystem is the common case and should be the plain one.
 */

/** A file, or a slice of one. Deliberately `Blob`-shaped. */
export interface CsFile {
  /** Full path within its filesystem, including any archive fragment. */
  readonly path: string;
  /** Basename, in the case the backing store reports. */
  readonly name: string;
  readonly size: number;
  /** MIME type when the backend knows one; `""` when it does not. */
  readonly type: string;

  /**
   * A view of part of this file, without reading anything yet.
   *
   * `end` is exclusive, as in `Blob.slice`. Negative offsets and out-of-range
   * values clamp rather than throw, again as `Blob.slice` does — a zip reader
   * asking for the last 64 KB of a 20 KB file should get 20 KB, not an error.
   */
  slice(start?: number, end?: number): CsFile;

  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  stream(): ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

export type CsEntry =
  | { readonly kind: "file"; readonly name: string; readonly size: number }
  | { readonly kind: "directory"; readonly name: string };

/** A directory listing. */
export interface CsDirectory {
  readonly path: string;
  readonly name: string;

  /** Direct children. */
  entries(): Promise<CsEntry[]>;
  /** A child file, or `null` if it is absent or is a directory. */
  file(name: string): Promise<CsFile | null>;
  /** A child directory, or `null` if it is absent or is a file. */
  directory(name: string): Promise<CsDirectory | null>;
}

/**
 * How names are matched.
 *
 * `"insensitive"` exists because real data sets are inconsistent about case —
 * an index may say `MS43.IPO` where a reference says `ms43.ipo`. It is not the
 * default, because it costs a full listing per lookup on backends that cannot
 * index by name, and because two files differing only in case then become
 * ambiguous.
 */
export type CaseSensitivity = "sensitive" | "insensitive";

/** A read-only filesystem. */
export interface CsFileSystem {
  /** Short name of the backend, for diagnostics: `"http"`, `"fsa"`, `"opfs"`. */
  readonly kind: string;

  /**
   * Resolve a path to a file.
   *
   * Paths are POSIX-style and rooted: `/pr/Planches.dat`. A leading slash is
   * optional. `null` means "not there", which is the normal, non-exceptional
   * answer — callers should not have to write a try/catch to test existence.
   *
   * A path may address inside an archive with `#`, e.g.
   * `/dessins/100.zip#/1132C000.png`, when the filesystem was wrapped for it.
   */
  file(path: string): Promise<CsFile | null>;

  /** Resolve a path to a directory. `"/"` is the root. */
  directory(path: string): Promise<CsDirectory | null>;

  /** Shorthand for `file(path)` then `bytes()`. `null` if absent. */
  read(path: string): Promise<Uint8Array | null>;

  /** Does this path exist, and as what? */
  stat(path: string): Promise<CsStat | null>;
}

export interface CsStat {
  readonly kind: "file" | "directory";
  readonly name: string;
  /** Bytes; `0` for a directory, and for backends that cannot say cheaply. */
  readonly size: number;
}

/**
 * Writing, for the backends that can.
 *
 * Separate from `CsFileSystem` so a consumer that only reads never sees it,
 * and so a function that needs to write says so in its signature.
 */
export interface WritableFileSystem extends CsFileSystem {
  /** Create or replace a file, creating parent directories. */
  write(path: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void>;
  /** Create a directory and its parents. Succeeds if it exists. */
  makeDirectory(path: string): Promise<void>;
  /** Remove a file or an empty directory. `recursive` removes a tree. */
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

/** True when a filesystem can be written to. */
export function isWritable(fs: CsFileSystem): fs is WritableFileSystem {
  const candidate = fs as Partial<WritableFileSystem>;
  return typeof candidate.write === "function" && typeof candidate.makeDirectory === "function";
}
