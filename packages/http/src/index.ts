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
 *   416, or a 206 shorter than asked for, or a 200 of the wrong length. That is
 *   a stale manifest, not a missing range, and it says so — a short read handed
 *   back as though it were the slice is exactly the silent wrong answer the
 *   other two are refused for.
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
  shared,
  untilAborted,
  type CsDirectory,
  type CsEntry,
  type CsFile,
  type CsFileSystem,
  type CsStat,
  type ReadOptions,
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
   * Memory for whole-file bodies when reading without ranges. Default 16 MiB;
   * `0` disables it.
   *
   * The most recently used bodies that fit, and a body larger than the whole
   * budget is never kept. That is not a general cache and is not meant to be
   * one — it exists because a single logical read is several slices of the
   * *same* file: an archive is opened by reading its end, then its central
   * directory, then an entry. Without it, a no-`Range` host would serve the
   * whole archive three times over for one file. More than one body, because
   * several archives can serve one directory and a lookup tries each in turn;
   * a single slot evicted one archive to read the next, every time.
   */
  wholeFileCacheBytes?: number;
}

/** Is this content type a web page rather than data? */
function looksLikeHtml(type: string): boolean {
  return /\b(text\/html|application\/xhtml)\b/.test(type);
}

/**
 * Is a web page here a sign the tree is somewhere else?
 *
 * Not when the file *is* a web page: a tree may well contain `index.html`, and
 * refusing to read a file the manifest lists because it is what it says it is
 * made it unreadable.
 */
function unexpectedHtml(res: Response, path: string): boolean {
  return looksLikeHtml(res.headers.get("content-type") ?? "") && !looksLikeHtml(mimeType(path));
}

/**
 * Let go of a body that will not be read.
 *
 * An unread body keeps its connection — on undici until garbage collection —
 * and a refused 200 keeps downloading the whole file in the background.
 */
function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/** `bytes a-b/total` → `[a, b]`, or `null` if absent or unreadable. */
function contentRange(res: Response): [number, number] | null {
  const m = /^bytes (\d+)-(\d+)\//.exec(res.headers.get("content-range") ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** A range once opened: a response still to consume, or bytes already cut. */
type Opened =
  { readonly partial: Response; readonly url: string } | { readonly whole: Uint8Array };

function shortRead(expected: number, got: number, url: string): BackendError {
  return new BackendError(
    `asked for ${expected} bytes, got ${got} — the manifest and the host disagree ` +
      `about this file's length`,
    url,
  );
}

/** Pass a body through, failing it if it is not exactly this long. */
function exactLength(expected: number, url: string): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expected) throw shortRead(expected, seen, url);
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== expected) throw shortRead(expected, seen, url);
    },
  });
}

function oneChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A manifest, uploaded gzipped or not. */
async function manifestJson(res: Response, url: string): Promise<unknown> {
  let bytes = new Uint8Array(await res.arrayBuffer());
  // Pre-gzipped and uploaded without `Content-Encoding` — which is how a
  // bucket serves a `.json` someone compressed to save the 9:1 — reaches here
  // still compressed. The magic number says so; nothing else will.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as unknown as ArrayBufferView<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new BackendError(`manifest is not JSON (${(e as Error).message})`, url);
  }
}

const DEFAULT_WHOLE_FILE_CACHE = 16 * 1024 * 1024;

export class HttpFileSystem implements CsFileSystem {
  readonly kind = "http";
  /** How this file system was told to read ranges. */
  readonly rangeMode: RangeMode;
  private readonly base: string;
  /** A base URL's query — a presigned or SAS token — carried onto every request. */
  private readonly query: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly manifestFile: string;
  private readonly caseInsensitive: boolean;
  private readonly wholeFileCacheBytes: number;
  private index: Promise<ManifestIndex> | undefined;
  /** `undefined` until a response has said one way or the other. */
  private ranges?: boolean;
  /**
   * The first `Range` request under `"auto"`, while it is in flight.
   *
   * Concurrent reads wait for it rather than each sending their own: on a host
   * that ignores the header, every one of them would otherwise download and
   * buffer the whole file before the first answer latched.
   */
  private probe: Promise<void> | undefined;
  /** Whole bodies, least recently used first. */
  private readonly whole = new Map<string, Uint8Array>();
  private wholeBytes = 0;
  /** Whole-body downloads in flight, so two slices of one file share one. */
  private readonly pending = new Map<string, (signal?: AbortSignal) => Promise<Uint8Array>>();

  constructor(baseUrl: string, opts: HttpFileSystemOptions = {}) {
    const [head, ...rest] = baseUrl.split("#")[0]!.split("?");
    this.base = head!.replace(/\/+$/, "");
    this.query = rest.length > 0 ? `?${rest.join("?")}` : "";
    // Bound, not just stored. `= fetch` makes `this.fetchImpl(...)` a *method*
    // call, so the browser's `fetch` receives this object as its `this` and
    // throws "Illegal invocation". Node tolerates it, so the mistake passes
    // every server-side test and fails only in a tab. That goes for an injected
    // one too — `{ fetch: window.fetch }` is the obvious thing to pass.
    const injected = opts.fetch;
    this.fetchImpl = injected
      ? (input, init) => injected(input, init)
      : (input, init) => globalThis.fetch(input, init);
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

  /**
   * Each segment encoded. Left to the URL parser, `#` starts a fragment and `?`
   * a query, so `/a#b.txt` fetched `/a` — a different file, or none — and
   * `directUrl` handed an `<img>` the same wrong address.
   */
  private url(path: string): string {
    const encoded = segments(normalizePath(path)).map(encodeURIComponent).join("/");
    return `${this.base}/${encoded}${this.query}`;
  }

  /**
   * Fetch and index the manifest, once it has succeeded.
   *
   * A failure is not kept: one dropped connection or a 503 while opening would
   * otherwise leave the instance broken for as long as it lived.
   */
  private manifest(): Promise<ManifestIndex> {
    this.index ??= (async () => {
      const url = `${this.base}/${this.manifestFile}${this.query}`;
      const res = await this.fetchImpl(url);
      if (!res.ok) {
        discard(res);
        throw new NotDataError(url, `HTTP ${res.status}`);
      }
      const type = res.headers.get("content-type") ?? "";
      if (looksLikeHtml(type)) {
        discard(res);
        throw new NotDataError(url, type);
      }
      return new ManifestIndex(parseManifest(await manifestJson(res, url)), {
        caseInsensitive: this.caseInsensitive,
      });
    })().catch((e: unknown) => {
      this.index = undefined;
      throw e;
    });
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
      {
        read: (start, end, signal) => this.readRange(canonical, size, start, end, signal),
        stream: (start, end) => this.streamRange(canonical, size, start, end),
      },
      mimeType(canonical),
    );
  }

  /**
   * Open a range: a response to read or stream, or — from a host that ignores
   * `Range` — the slice already cut from the whole body.
   *
   * The only place a range is requested, so reading and streaming cannot
   * disagree about what a response means.
   */
  private async openRange(
    path: string,
    size: number,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Opened> {
    signal?.throwIfAborted();
    if (this.ranges === undefined && this.probe) {
      // Someone is already finding out; their answer decides how to ask.
      await untilAborted(this.probe, signal);
      return this.openRange(path, size, start, end, signal);
    }
    // `"auto"` stops asking once a host has shown it ignores the header:
    // the probe is only worth one round trip, not one per read.
    if (this.ranges === false) {
      return { whole: (await this.wholeBody(path, size, signal)).slice(start, end) };
    }
    const opening = this.rangeResponse(path, size, start, end, signal);
    if (this.ranges === undefined) {
      // Settles either way and never rejects: its failure is the reader's to
      // report, not an unhandled rejection when nobody else was waiting.
      const probe: Promise<void> = opening
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          if (this.probe === probe) this.probe = undefined;
        });
      this.probe = probe;
    }
    return opening;
  }

  /** The only place bytes are fetched. `size` is what the manifest says. */
  private async readRange(
    path: string,
    size: number,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    if (end <= start) return new Uint8Array(0);
    const opened = await this.openRange(path, size, start, end, signal);
    if ("whole" in opened) return opened.whole;
    const bytes = new Uint8Array(await opened.partial.arrayBuffer());
    if (bytes.byteLength !== end - start)
      throw shortRead(end - start, bytes.byteLength, opened.url);
    return bytes;
  }

  /**
   * A range as a stream, straight from the response body.
   *
   * `RangeFile`'s own `stream()` reads the whole range first, which for the
   * 945 MB archive this backend exists to sample means holding all of it
   * before the first byte reaches the caller. The length is still checked, as
   * it passes: a stream that ends short errors rather than ending cleanly.
   */
  private streamRange(
    path: string,
    size: number,
    start: number,
    end: number,
  ): ReadableStream<Uint8Array> {
    const cancel = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (!reader) {
          const opened = await this.openRange(path, size, start, end, cancel.signal);
          const body =
            "whole" in opened
              ? oneChunk(opened.whole)
              : (opened.partial.body ?? oneChunk(new Uint8Array(0))).pipeThrough(
                  exactLength(end - start, opened.url),
                );
          reader = body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: async (reason) => {
        cancel.abort(reason);
        await reader?.cancel(reason);
      },
    });
  }

  private async rangeResponse(
    path: string,
    size: number,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Opened> {
    const url = this.url(path);
    const res = await this.fetchImpl(url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
      ...(signal ? { signal } : {}),
    });
    // Status first. A 404 that happens to be an HTML page is a missing file,
    // not a sign the whole tree is elsewhere, and saying the second sends
    // someone to check a base URL that is fine.
    if (res.status !== 206 && res.status !== 200) {
      discard(res);
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
    if (unexpectedHtml(res, path)) {
      discard(res);
      throw new NotDataError(url, res.headers.get("content-type") ?? "");
    }

    if (res.status === 206) {
      this.ranges = true;
      // A 206 is not proof of the *asked-for* bytes. A host clamps a range to
      // the file it has, so a manifest that says the file is longer gets a
      // short read here; a proxy may answer with a different range entirely.
      // Either one used as the slice is wrong bytes with no error. The length
      // is checked by whoever consumes the body.
      const got = contentRange(res);
      if (got && (got[0] !== start || got[1] !== end - 1)) {
        discard(res);
        throw new BackendError(
          `asked for bytes ${start}-${end - 1}, got ${got[0]}-${got[1]} — the manifest ` +
            `and the host disagree about this file's length`,
          url,
        );
      }
      return { partial: res, url };
    }
    // The host ignored the header, so this body is the *whole* file. Using it
    // as the slice would hand back the wrong bytes with no error at all — so
    // it is either sliced here or refused, never passed through.
    if (this.rangeMode === "require") {
      discard(res);
      throw new RangeUnsupportedError(url, res.status);
    }
    this.ranges = false;
    const bytes = await this.checkedBody(res, url, size);
    this.remember(path, bytes);
    return { whole: bytes.slice(start, end) };
  }

  /** A whole body, refused if it is not the length the manifest records. */
  private async checkedBody(res: Response, url: string, size: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength !== size) {
      throw new BackendError(
        `manifest says ${size} bytes, host sent ${bytes.byteLength} — the manifest is stale`,
        url,
      );
    }
    return bytes;
  }

  /** The whole file, for the no-`Range` path. Kept while it fits the budget. */
  private wholeBody(path: string, size: number, signal?: AbortSignal): Promise<Uint8Array> {
    const kept = this.whole.get(path);
    if (kept) {
      // Re-inserted, so the map's order stays least-recently-used first.
      this.whole.delete(path);
      this.whole.set(path, kept);
      return Promise.resolve(kept);
    }
    // Shared, so two slices of an uncached file cost one download, not two —
    // and cancelled only once every reader waiting on it has given up.
    let pending = this.pending.get(path);
    if (!pending) {
      const task = shared(async (cancel) => {
        const url = this.url(path);
        const res = await this.fetchImpl(url, { signal: cancel });
        if (!res.ok) {
          discard(res);
          throw new BackendError(`HTTP ${res.status}`, url);
        }
        if (unexpectedHtml(res, path)) {
          discard(res);
          throw new NotDataError(url, res.headers.get("content-type") ?? "");
        }
        const bytes = await this.checkedBody(res, url, size);
        this.remember(path, bytes);
        return bytes;
      });
      // Out of the map once it settles either way: a success is in `whole`
      // now, or is too big to be, and a failure should be tried afresh.
      pending = (s?: AbortSignal) => {
        const run = task(s);
        run.then(
          () => this.pending.delete(path),
          () => {
            if (!s?.aborted) this.pending.delete(path);
          },
        );
        return run;
      };
      this.pending.set(path, pending);
    }
    return pending(signal);
  }

  private remember(path: string, bytes: Uint8Array): void {
    const previous = this.whole.get(path);
    if (previous) {
      this.whole.delete(path);
      this.wholeBytes -= previous.byteLength;
    }
    // Never kept rather than evicting everything else for it: holding nothing
    // while repeatedly refetching a body larger than the budget is no worse,
    // and emptying the cache for it would make the smaller files pay too.
    if (bytes.byteLength > this.wholeFileCacheBytes) return;
    this.whole.set(path, bytes);
    this.wholeBytes += bytes.byteLength;
    for (const [oldest, body] of this.whole) {
      if (this.wholeBytes <= this.wholeFileCacheBytes) break;
      this.whole.delete(oldest);
      this.wholeBytes -= body.byteLength;
    }
  }

  async directory(path: string): Promise<CsDirectory | null> {
    const index = await this.manifest();
    const canonical = index.canonical(path);
    if (canonical === null || !index.hasDirectory(canonical)) return null;
    return new HttpDirectory(this, index, canonical);
  }

  async read(path: string, opts?: ReadOptions): Promise<Uint8Array | null> {
    return (await this.file(path))?.bytes(opts) ?? null;
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
