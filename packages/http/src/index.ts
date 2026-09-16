/**
 * A file system over static HTTP.
 *
 * Reads by `Range`, so a 945 MB archive can be sampled rather than downloaded,
 * and lists from a manifest, because HTTP cannot list a directory.
 *
 * Three failures this refuses to paper over, each of which otherwise presents
 * as data that is subtly wrong rather than as an error:
 *
 * - **A host that ignores `Range`** answers 200 with the whole body. Reading
 *   that body *as though it were the slice* yields the wrong bytes, silently.
 *   So it is never used as one: either the whole body is sliced locally (the
 *   default, `ranges: "auto"`) or the response is refused outright
 *   (`ranges: "require"`).
 * - **A single-page app answers any unknown path with its own HTML and a 200**,
 *   so a mistyped base URL looks like a working tree whose files all happen to
 *   be documents. An HTML content type where data was expected is its own error
 *   type, distinct from a 404, because the two need opposite handling.
 * - **A host that disagrees with the manifest** about a file's length answers
 *   416. That is a stale manifest, not a missing range, and it says so.
 */
import {
  BackendError,
  NotDataError,
  RangeFile,
  RangeUnsupportedError,
  basename,
  mimeType,
  normalizePath,
  segments,
  type CsDirectory,
  type CsEntry,
  type CsFile,
  type CsFileSystem,
  type CsStat,
} from "@emdzej/csfs-core";
import {
  MANIFEST_FILE,
  ManifestIndex,
  parseManifest,
  type Manifest,
} from "@emdzej/csfs-manifest";

/**
 * How to read part of a file.
 *
 * - `"auto"` — ask for a range; if the host ignores the header and sends the
 *   whole file, slice it here and stop asking. Correct either way, which is
 *   why it is the default: a consumer should not have to know in advance
 *   whether a host it was handed honours `Range`.
 * - `"require"` — a non-206 is `RangeUnsupportedError`. For a consumer that
 *   would rather fail than download 945 MB to read 64 KB of it.
 * - `"never"` — plain GET, sliced locally, no `Range` header sent at all. For
 *   a host known not to support it, where the probe is a wasted round trip.
 */
export type RangeMode = "auto" | "require" | "never";

export interface HttpFileSystemOptions {
  /** Injected for tests, for auth headers, or for a caching wrapper. */
  fetch?: typeof globalThis.fetch;
  /** Manifest file name, relative to the base URL. */
  manifestFile?: string;
  /**
   * Use this manifest instead of fetching one.
   *
   * For a consumer that already has it — bundled, or cached from a previous
   * visit — so opening a tree costs no round trip at all.
   */
  manifest?: Manifest;
  /**
   * Resolve a path without regard to case.
   *
   * Cheap here, unlike on a handle-backed backend: the manifest is already in
   * memory, so this is one extra map and no extra request. Real data sets are
   * inconsistent about case — an index may say `MS43.PRG` where a reference
   * says `ms43.prg` — and a tree rsynced off Windows onto a Linux host is
   * exactly where that bites.
   *
   * The file handed back carries the path the *manifest* records, not the one
   * asked for, because the name is often passed on to something that cares.
   */
  caseInsensitive?: boolean;
  /** How to read part of a file. Default `"auto"`. */
  ranges?: RangeMode;
  /**
   * Largest whole-file body kept in memory when reading without ranges.
   * Default 16 MiB; `0` disables it.
   *
   * One body, the most recent. That is not a general cache and is not meant to
   * be one — it exists because a single logical read is several slices of the
   * *same* file: an archive is opened by reading its end, then its central
   * directory, then an entry. Without it, a no-`Range` host would serve the
   * whole archive three times over for one file.
   */
  wholeFileCacheBytes?: number;
}

/** Is this content type a web page rather than data? */
function looksLikeHtml(type: string): boolean {
  return /\b(text\/html|application\/xhtml)\b/.test(type);
}

const DEFAULT_WHOLE_FILE_CACHE = 16 * 1024 * 1024;

export class HttpFileSystem implements CsFileSystem {
  readonly kind = "http";
  /** How this file system was told to read ranges. */
  readonly rangeMode: RangeMode;
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly manifestFile: string;
  private readonly caseInsensitive: boolean;
  private readonly wholeFileCacheBytes: number;
  private index?: Promise<ManifestIndex>;
  /** `undefined` until a response has said one way or the other. */
  private ranges?: boolean;
  /**
   * The most recent whole body, when reading without ranges.
   *
   * Declared `| undefined` rather than optional because `exactOptionalPropertyTypes`
   * distinguishes the two, and this one is genuinely cleared again.
   */
  private whole: { path: string; bytes: Uint8Array } | undefined;

  constructor(baseUrl: string, opts: HttpFileSystemOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    // Bound, not just stored. `= fetch` makes `this.fetchImpl(...)` a *method*
    // call, so the browser's `fetch` receives this object as its `this` and
    // throws "Illegal invocation". Node tolerates it, so the mistake passes
    // every server-side test and fails only in a tab.
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.manifestFile = opts.manifestFile ?? MANIFEST_FILE;
    this.caseInsensitive = opts.caseInsensitive ?? false;
    this.rangeMode = opts.ranges ?? "auto";
    this.wholeFileCacheBytes = opts.wholeFileCacheBytes ?? DEFAULT_WHOLE_FILE_CACHE;
    if (this.rangeMode === "never") this.ranges = false;
    if (opts.manifest) {
      this.index = Promise.resolve(
        new ManifestIndex(opts.manifest, { caseInsensitive: this.caseInsensitive }),
      );
    }
  }

  /**
   * Whether the host honours `Range`. `undefined` until something has been
   * read, since nothing else can tell.
   *
   * Worth surfacing: under `"auto"` a host that ignores the header still works,
   * but every read then costs a whole file, and a consumer showing a progress
   * bar or a warning wants to know which of the two it is doing.
   */
  get rangesSupported(): boolean | undefined {
    return this.ranges;
  }

  private url(path: string): string {
    return `${this.base}${normalizePath(path)}`;
  }

  /** Fetch and index the manifest, once. */
  private manifest(): Promise<ManifestIndex> {
    this.index ??= (async () => {
      const url = `${this.base}/${this.manifestFile}`;
      const res = await this.fetchImpl(url);
      if (!res.ok) {
        throw new NotDataError(url, `HTTP ${res.status}`);
      }
      const type = res.headers.get("content-type") ?? "";
      if (looksLikeHtml(type)) throw new NotDataError(url, type);
      return new ManifestIndex(parseManifest(await res.json()), {
        caseInsensitive: this.caseInsensitive,
      });
    })();
    return this.index;
  }

  /** The manifest, for a caller that wants to cache or inspect it. */
  async describe(): Promise<Manifest> {
    return (await this.manifest()).manifest;
  }

  /** Archives the tree declares, for `withTransparentArchives`. */
  async archives(): Promise<NonNullable<Manifest["archives"]>> {
    return (await this.describe()).archives ?? [];
  }

  /**
   * Paths in the manifest that differ only in case.
   *
   * Always empty unless opened case-insensitively, since nothing is otherwise
   * ambiguous. When it is not empty, only the first of each group is reachable.
   */
  async caseCollisions(): Promise<string[][]> {
    return (await this.manifest()).caseCollisions;
  }

  async file(path: string): Promise<CsFile | null> {
    const index = await this.manifest();
    const canonical = index.canonical(path);
    if (canonical === null) return null;
    const size = index.size(canonical);
    // A directory resolves but has no size; asking for it as a file is a miss.
    if (size === undefined) return null;
    return new RangeFile(
      canonical,
      size,
      (start, end) => this.readRange(canonical, start, end),
      mimeType(canonical),
    );
  }

  /** The only place bytes are fetched. */
  private async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
    if (end <= start) return new Uint8Array(0);
    // `"auto"` stops asking once a host has shown it ignores the header:
    // the probe is only worth one round trip, not one per read.
    if (this.ranges === false) {
      return (await this.wholeBody(path)).slice(start, end);
    }

    const url = this.url(path);
    const res = await this.fetchImpl(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    const type = res.headers.get("content-type") ?? "";
    if (looksLikeHtml(type)) throw new NotDataError(url, type);

    if (res.status === 206) {
      this.ranges = true;
      return new Uint8Array(await res.arrayBuffer());
    }
    if (res.status === 200) {
      // The host ignored the header, so this body is the *whole* file. Using it
      // as the slice would hand back the wrong bytes with no error at all — so
      // it is either sliced here or refused, never passed through.
      if (this.rangeMode === "require") throw new RangeUnsupportedError(url, res.status);
      this.ranges = false;
      const bytes = new Uint8Array(await res.arrayBuffer());
      this.remember(path, bytes);
      return bytes.slice(start, end);
    }
    if (res.status === 416) {
      // Not "no such range" — the manifest says this file is longer than the
      // host thinks it is, which means the manifest is stale. Saying "range
      // unsupported" would send someone to check their server config.
      throw new BackendError(
        `range ${start}-${end - 1} is not satisfiable — the manifest and the host ` +
          `disagree about this file's length`,
        url,
      );
    }
    throw new BackendError(`HTTP ${res.status} on a Range request`, url);
  }

  /** The whole file, for the no-`Range` path. Keeps the most recent body. */
  private async wholeBody(path: string): Promise<Uint8Array> {
    if (this.whole?.path === path) return this.whole.bytes;
    const url = this.url(path);
    const res = await this.fetchImpl(url);
    const type = res.headers.get("content-type") ?? "";
    if (looksLikeHtml(type)) throw new NotDataError(url, type);
    if (!res.ok) throw new BackendError(`HTTP ${res.status}`, url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.remember(path, bytes);
    return bytes;
  }

  private remember(path: string, bytes: Uint8Array): void {
    if (bytes.byteLength > this.wholeFileCacheBytes) {
      // Explicitly dropped rather than left in place: holding the previous
      // file while repeatedly refetching a larger one is the worst of both.
      if (this.whole?.path === path) this.whole = undefined;
      return;
    }
    this.whole = { path, bytes };
  }

  async directory(path: string): Promise<CsDirectory | null> {
    const index = await this.manifest();
    const canonical = index.canonical(path);
    if (canonical === null || !index.hasDirectory(canonical)) return null;
    return new HttpDirectory(this, index, canonical);
  }

  async read(path: string): Promise<Uint8Array | null> {
    return (await this.file(path))?.bytes() ?? null;
  }

  async stat(path: string): Promise<CsStat | null> {
    const index = await this.manifest();
    const canonical = index.canonical(path);
    if (canonical === null) return null;
    const size = index.size(canonical);
    if (size !== undefined) return { kind: "file", name: basename(canonical), size };
    if (index.hasDirectory(canonical)) {
      return { kind: "directory", name: basename(canonical), size: 0 };
    }
    return null;
  }

  /**
   * A URL the browser can load directly — an `<img>` or an `<iframe>` source.
   *
   * Only for paths the manifest lists, deliberately. Returning a URL for
   * anything asked would make this useless as an existence test, and a caller
   * that then wants to fall back to an archive never gets the chance: it would
   * hold a URL that 404s, and an `<img>` would simply never load.
   */
  async directUrl(path: string): Promise<string | null> {
    const index = await this.manifest();
    const canonical = index.canonical(path);
    if (canonical === null || !index.hasFile(canonical)) return null;
    return this.url(canonical);
  }
}

class HttpDirectory implements CsDirectory {
  readonly name: string;

  constructor(
    private readonly fs: HttpFileSystem,
    private readonly index: ManifestIndex,
    readonly path: string,
  ) {
    this.name = basename(path);
  }

  async entries(): Promise<CsEntry[]> {
    const out: CsEntry[] = [];
    for (const [name, size] of this.index.entriesOf(this.path)) {
      out.push(size === null ? { kind: "directory", name } : { kind: "file", name, size });
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

/** Open a static HTTP tree. Nothing is fetched until something is asked for. */
export function httpFileSystem(baseUrl: string, opts?: HttpFileSystemOptions): HttpFileSystem {
  return new HttpFileSystem(baseUrl, opts);
}

export { segments };
