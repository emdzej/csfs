/**
 * Paths, and the archive fragment.
 *
 * A csfs path is POSIX-style and rooted, with one extra piece of syntax: `#`
 * separates a container from a path *inside* it.
 *
 *     /dessins/100.zip#/1132C000.png
 *     /outer.zip#/inner.zip#/deep/file.txt
 *
 * `#` was chosen over a second argument or a `zip://` scheme because it keeps
 * a location a single string. A path that survives being logged, stored in a
 * manifest, put in a URL fragment or handed between a worker and a page is
 * worth more than a tidier type — and every one of those places already
 * accepts a string.
 *
 * Nesting is supported for the same reason: it costs one loop, and the
 * alternative is a special case that someone eventually hits.
 */

/** A path split into its container chain and the final path inside it. */
export interface ParsedPath {
  /** The outermost path in the host filesystem. Never contains `#`. */
  readonly base: string;
  /**
   * Paths inside each successive container, outermost first.
   *
   * Empty for an ordinary path. For `a.zip#/b.zip#/c.txt` this is
   * `["/b.zip", "/c.txt"]` — note that the *second* element is inside the
   * archive named by the first.
   */
  readonly fragments: readonly string[];
}

/**
 * Normalise a path: single leading slash, no trailing slash, no `.` or `..`.
 *
 * `..` is resolved rather than rejected, and cannot escape the root — a path
 * from a manifest or a URL is untrusted input, and `/a/../../etc` resolving to
 * `/etc` inside someone's data directory is the whole reason to do this here
 * rather than in each backend.
 */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** Split a path on `#`, normalising each piece. */
export function parsePath(path: string): ParsedPath {
  const pieces = path.split("#");
  const base = normalizePath(pieces[0] ?? "");
  const fragments = pieces.slice(1).map((p) => normalizePath(p));
  return { base, fragments };
}

/** Rebuild a path from its pieces. The inverse of `parsePath`. */
export function formatPath(parsed: ParsedPath): string {
  return [parsed.base, ...parsed.fragments].join("#");
}

/** Everything before the last segment, or `"/"` at the root. */
export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const at = normalized.lastIndexOf("/");
  return at <= 0 ? "/" : normalized.slice(0, at);
}

/** The last segment. `""` for the root. */
export function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** The extension including the dot, lower-cased, or `""`. */
export function extname(path: string): string {
  const name = basename(path);
  const at = name.lastIndexOf(".");
  return at <= 0 ? "" : name.slice(at).toLowerCase();
}

/** Join segments into a normalised path. */
export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

/** Split a normalised path into its segments, without empties. */
export function segments(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}
