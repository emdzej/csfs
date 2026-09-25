/**
 * File implementations that every backend can share.
 *
 * `BlobFile` covers anything already `Blob`-shaped — a `File` from a picked
 * directory, an OPFS file, a `Blob` built in memory — which is most of them.
 * `RangeFile` covers the rest: a store that can answer "bytes m to n" but has
 * no `Blob`, which is what HTTP is.
 *
 * Both exist so a backend supplies the one primitive it actually has and gets
 * `slice`, `arrayBuffer`, `bytes`, `stream` and `text` for nothing.
 */
import type { CsFile, ReadOptions } from "./types.js";
import { basename } from "./path.js";

/** Minimal `Blob` surface. `Blob` and `File` both satisfy it as they are. */
export interface BlobLike {
  readonly size: number;
  readonly type?: string;
  slice(start?: number, end?: number, contentType?: string): BlobLike;
  arrayBuffer(): Promise<ArrayBuffer>;
  stream(): unknown;
  text(): Promise<string>;
}

/** A `CsFile` over anything `Blob`-shaped. */
export class BlobFile implements CsFile {
  readonly path: string;
  readonly name: string;

  constructor(
    path: string,
    private readonly blob: BlobLike,
    /** Overrides the blob's own type, which is often `""` from a file handle. */
    private readonly mime?: string,
  ) {
    this.path = path;
    this.name = basename(path.split("#").at(-1) ?? path);
  }

  get size(): number {
    return this.blob.size;
  }

  get type(): string {
    return this.mime ?? this.blob.type ?? "";
  }

  slice(start?: number, end?: number): CsFile {
    return new BlobFile(this.path, this.blob.slice(start, end), this.mime);
  }

  /*
   * A `Blob` read cannot be cancelled, so a signal is honoured at the edges:
   * already aborted, the read does not start; aborted during it, the result is
   * not handed over. For a file on disk or in memory, that is most of the
   * value a signal has.
   */
  async arrayBuffer(opts?: ReadOptions): Promise<ArrayBuffer> {
    opts?.signal?.throwIfAborted();
    const buffer = await this.blob.arrayBuffer();
    opts?.signal?.throwIfAborted();
    return buffer;
  }

  async bytes(opts?: ReadOptions): Promise<Uint8Array> {
    return new Uint8Array(await this.arrayBuffer(opts));
  }

  stream(): ReadableStream<Uint8Array> {
    return this.blob.stream() as ReadableStream<Uint8Array>;
  }

  async text(opts?: ReadOptions): Promise<string> {
    opts?.signal?.throwIfAborted();
    const text = await this.blob.text();
    opts?.signal?.throwIfAborted();
    return text;
  }
}

/**
 * Reads a byte range. The one primitive a remote backend has to provide.
 *
 * `end` is exclusive. A backend may return fewer bytes than asked for only at
 * the end of the file; anything else is a bug in the backend, not something
 * callers should have to tolerate.
 */
export type RangeReader = (
  start: number,
  end: number,
  signal?: AbortSignal,
) => Promise<Uint8Array>;

/** Streams a byte range. Cancelling the stream cancels the read. */
export type RangeStreamer = (start: number, end: number) => ReadableStream<Uint8Array>;

/**
 * What a `RangeFile` reads through: a reader, and optionally a streamer.
 *
 * Without a streamer, `stream()` reads the whole range and yields it as one
 * chunk — correct, but for a large range it holds all of it before the first
 * byte reaches the caller. A backend that can stream supplies one.
 */
export interface RangeSource {
  readonly read: RangeReader;
  readonly stream?: RangeStreamer;
}

/** An offset as `Blob.slice` reads one: NaN is 0, a fraction truncates. */
function toOffset(n: number): number {
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

/**
 * A `CsFile` over a range reader — the HTTP case.
 *
 * Slicing composes by arithmetic rather than by fetching, so
 * `file.slice(a, b).slice(c, d)` costs nothing until something is read. That
 * matters for archives: a zip reader slices its way to a central directory
 * through several layers before touching the network once.
 */
export class RangeFile implements CsFile {
  readonly path: string;
  readonly name: string;

  private readonly source: RangeSource;

  constructor(
    path: string,
    private readonly total: number,
    source: RangeReader | RangeSource,
    private readonly mime = "",
    /** Window into the underlying object: `[start, end)`. */
    private readonly start = 0,
    private readonly end = total,
  ) {
    this.path = path;
    this.name = basename(path.split("#").at(-1) ?? path);
    this.source = typeof source === "function" ? { read: source } : source;
  }

  get size(): number {
    return Math.max(0, this.end - this.start);
  }

  get type(): string {
    return this.mime;
  }

  slice(start = 0, end = this.size): CsFile {
    // Clamp like `Blob.slice`: negative offsets count from the end, and
    // over-long ranges truncate. A zip reader asking for the last 64 KB of a
    // 20 KB file must get 20 KB rather than an error. Offsets are made whole
    // first, as a `Blob` makes them: NaN let through made the size NaN, and a
    // fraction reached the reader as a `Range` header no host accepts.
    start = toOffset(start);
    end = toOffset(end);
    const size = this.size;
    const from = start < 0 ? Math.max(0, size + start) : Math.min(start, size);
    const to = end < 0 ? Math.max(0, size + end) : Math.min(end, size);
    const lo = this.start + from;
    const hi = this.start + Math.max(from, to);
    return new RangeFile(this.path, this.total, this.source, this.mime, lo, hi);
  }

  async bytes(opts?: ReadOptions): Promise<Uint8Array> {
    opts?.signal?.throwIfAborted();
    if (this.size === 0) return new Uint8Array(0);
    return await this.source.read(this.start, this.end, opts?.signal);
  }

  async arrayBuffer(opts?: ReadOptions): Promise<ArrayBuffer> {
    const bytes = await this.bytes(opts);
    // A fresh buffer: the view may be a window into a larger one, and handing
    // that out would expose bytes the caller did not ask for. Even a view that
    // is its whole buffer is copied, because that buffer may be one a reader
    // keeps — `bytesFile`'s, or a cached body — and a caller writing into what
    // `Blob.arrayBuffer` promises is theirs would change later reads.
    return bytes.slice().buffer as ArrayBuffer;
  }

  stream(): ReadableStream<Uint8Array> {
    if (this.size === 0) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    }
    if (this.source.stream) return this.source.stream(this.start, this.end);
    // One chunk: the correct-but-simple fallback for a source that cannot
    // stream.
    const self = this;
    const cancel = new AbortController();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(await self.bytes({ signal: cancel.signal }));
        controller.close();
      },
      cancel(reason) {
        cancel.abort(reason);
      },
    });
  }

  async text(opts?: ReadOptions): Promise<string> {
    return new TextDecoder().decode(await this.bytes(opts));
  }
}

/** A `CsFile` over bytes already in memory. */
export function bytesFile(path: string, data: Uint8Array, mime = ""): CsFile {
  return new RangeFile(
    path,
    data.byteLength,
    async (start, end) => data.subarray(start, end),
    mime,
  );
}

/**
 * A `CsFile` over a `Blob` or a `File`.
 *
 * The one-liner for the common case: a file the user picked, dropped, or chose
 * with `<input type="file">`. The path defaults to the file's own name so a
 * caller passing a `File` needs nothing else.
 */
export function blobFile(
  blob: BlobLike & { name?: string },
  path?: string,
  mime?: string,
): CsFile {
  const resolved = path ?? `/${blob.name ?? "file"}`;
  return new BlobFile(resolved, blob, mime);
}

/**
 * A `Blob` from bytes, with the type set.
 *
 * Here rather than in each caller because every consumer meets the same
 * friction: TypeScript will not accept a `Uint8Array<ArrayBufferLike>` as a
 * `BlobPart`, since the buffer *might* be a `SharedArrayBuffer`. It never is,
 * for bytes that came out of a file, so the cast belongs at one boundary
 * instead of being rediscovered at every call site.
 *
 * Setting the type matters: an `<img>` will sniff a typeless blob and cope,
 * but an `<iframe>` handed a typeless PDF offers a download rather than
 * rendering it.
 */
export function toBlob(bytes: Uint8Array, type = "application/octet-stream"): Blob {
  return new Blob([bytes as unknown as ArrayBufferView<ArrayBuffer>], { type });
}

/**
 * An object URL for a file's contents.
 *
 * **The caller must revoke it.** A page that mints one per image and never
 * revokes pins every image it has ever shown in memory.
 */
export async function objectUrl(file: CsFile): Promise<string> {
  return URL.createObjectURL(toBlob(await file.bytes(), file.type));
}
