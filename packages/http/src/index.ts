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
 *   that as the requested slice yields the wrong bytes, silently. Anything but
 *   206 is rejected.
 * - **A single-page app answers any unknown path with its own HTML and a 200**,
 *   so a mistyped base URL looks like a working tree whose files all happen to
 *   be documents. An HTML content type where data was expected is its own error
 *   type, distinct from a 404, because the two need opposite handling.
 * - **A missing `Content-Length`** means the size is unknown, and a zip read
 *   from its end cannot start. Better to say so than to guess.
 */
import {
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
}

/** Is this content type a web page rather than data? */
function looksLikeHtml(type: string): boolean {
  return /\b(text\/html|application\/xhtml)\b/.test(type);
}

export class HttpFileSystem implements CsFileSystem {
  readonly kind = "http";
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly manifestFile: string;
  private index?: Promise<ManifestIndex>;

  constructor(
    baseUrl: string,
    private readonly opts: HttpFileSystemOptions = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
    // Bound, not just stored. `= fetch` makes `this.fetchImpl(...)` a *method*
    // call, so the browser's `fetch` receives this object as its `this` and
    // throws "Illegal invocation". Node tolerates it, so the mistake passes
    // every server-side test and fails only in a tab.
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.manifestFile = opts.manifestFile ?? MANIFEST_FILE;
    if (opts.manifest) this.index = Promise.resolve(new ManifestIndex(opts.manifest));
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
      return new ManifestIndex(parseManifest(await res.json()));
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

  async file(path: string): Promise<CsFile | null> {
    const index = await this.manifest();
    const full = normalizePath(path);
    const size = index.size(full);
    if (size === undefined) return null;
    return new RangeFile(
      full,
      size,
      (start, end) => this.readRange(full, start, end),
      mimeType(full),
    );
  }

  /** One `Range` request. The only place bytes are fetched. */
  private async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
    const url = this.url(path);
    if (end <= start) return new Uint8Array(0);
    const res = await this.fetchImpl(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (res.status === 200) {
      // The host ignored the header. Its body is the *whole* file, so using it
      // as the slice would hand back the wrong bytes with no error at all.
      throw new RangeUnsupportedError(url, res.status);
    }
    if (res.status !== 206) {
      throw new RangeUnsupportedError(url, res.status);
    }
    const type = res.headers.get("content-type") ?? "";
    if (looksLikeHtml(type)) throw new NotDataError(url, type);
    return new Uint8Array(await res.arrayBuffer());
  }

  async directory(path: string): Promise<CsDirectory | null> {
    const index = await this.manifest();
    const full = normalizePath(path);
    if (!index.hasDirectory(full)) return null;
    return new HttpDirectory(this, index, full);
  }

  async read(path: string): Promise<Uint8Array | null> {
    return (await this.file(path))?.bytes() ?? null;
  }

  async stat(path: string): Promise<CsStat | null> {
    const index = await this.manifest();
    const full = normalizePath(path);
    const size = index.size(full);
    if (size !== undefined) return { kind: "file", name: basename(full), size };
    if (index.hasDirectory(full)) return { kind: "directory", name: basename(full), size: 0 };
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
    const full = normalizePath(path);
    return index.hasFile(full) ? this.url(full) : null;
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
