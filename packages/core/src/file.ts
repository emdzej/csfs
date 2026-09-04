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
import type { CsFile } from "./types.js";
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

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.blob.arrayBuffer();
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(await this.blob.arrayBuffer());
  }

  stream(): ReadableStream<Uint8Array> {
    return this.blob.stream() as ReadableStream<Uint8Array>;
  }

  text(): Promise<string> {
    return this.blob.text();
  }
}

/**
 * Reads a byte range. The one primitive a remote backend has to provide.
 *
 * `end` is exclusive. A backend may return fewer bytes than asked for only at
 * the end of the file; anything else is a bug in the backend, not something
 * callers should have to tolerate.
 */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

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

  constructor(
    path: string,
    private readonly total: number,
    private readonly read: RangeReader,
    private readonly mime = "",
    /** Window into the underlying object: `[start, end)`. */
    private readonly start = 0,
    private readonly end = total,
  ) {
    this.path = path;
    this.name = basename(path.split("#").at(-1) ?? path);
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
    // 20 KB file must get 20 KB rather than an error.
    const size = this.size;
    const from = start < 0 ? Math.max(0, size + start) : Math.min(start, size);
    const to = end < 0 ? Math.max(0, size + end) : Math.min(end, size);
    const lo = this.start + from;
    const hi = this.start + Math.max(from, to);
    return new RangeFile(this.path, this.total, this.read, this.mime, lo, hi);
  }

  async bytes(): Promise<Uint8Array> {
    if (this.size === 0) return new Uint8Array(0);
    return await this.read(this.start, this.end);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes();
    // A fresh buffer: the view may be a window into a larger one, and handing
    // that out would expose bytes the caller did not ask for.
    return bytes.slice().buffer as ArrayBuffer;
  }

  stream(): ReadableStream<Uint8Array> {
    // One chunk. A backend that can stream natively should override this by
    // supplying its own `CsFile`; this is the correct-but-simple fallback.
    const self = this;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(await self.bytes());
        controller.close();
      },
    });
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
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
