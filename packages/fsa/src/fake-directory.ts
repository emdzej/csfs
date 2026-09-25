/**
 * An in-memory stand-in for `FileSystemDirectoryHandle`, for tests.
 *
 * The File System Access API does not exist in Node, which is why this package
 * had no tests. That is a poor reason to have none: the interesting behaviour
 * here is name resolution and `create` semantics, and neither needs a real
 * filesystem to exercise — only something that answers `entries`,
 * `getDirectoryHandle` and `getFileHandle` the way a browser does.
 *
 * Deliberately literal about two things a fake usually gets wrong, because both
 * are what the code under test depends on:
 *
 * - **Names are case-sensitive** by default, as they are in Chromium's and
 *   Firefox's OPFS. A fake that folded by default would hide every bug in the
 *   case-insensitive resolution layer above it. WebKit's OPFS *does* fold —
 *   the e2e suite found it — so `folds: true` imitates that too.
 * - **`getDirectoryHandle` without `create` rejects** with `NotFoundError`
 *   rather than returning null, which is what the spec says and what the
 *   `try`/`catch` in the resolver is written against. Asking for a file by a
 *   directory's name, or the reverse, rejects with `TypeMismatchError`, as a
 *   browser does — the resolver tells those apart from a refusal.
 */

type Entry = FakeDirectory | FakeFile;

/**
 * A handle opened by a spelling other than the stored one, as WebKit gives it.
 *
 * Measured in the e2e suite: WebKit's handle calls itself by the name it was
 * *asked* for, and its `isSameEntry` compares paths, so it denies being the
 * stored entry it is. A fake that returned the stored handle instead was kinder
 * than the engine, and passed a resolver the engine broke.
 */
function alias<T extends Entry>(entry: T, name: string): T {
  if (entry.name === name) return entry;
  const proxy: T = new Proxy(entry, {
    get(target, prop) {
      if (prop === "name") return name;
      if (prop === "isSameEntry") return async (other: unknown) => other === proxy;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}

class FakeFile {
  readonly kind = "file" as const;
  constructor(
    readonly name: string,
    private data: Uint8Array = new Uint8Array(),
  ) {}

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }

  async getFile(): Promise<File> {
    return new File([this.data as BlobPart], this.name);
  }

  /**
   * Collects the written chunks and swaps them in on close, as the real one
   * does.
   *
   * `FileSystemWritableFileStream` is a `WritableStream` *and* carries
   * `write`/`close`/`seek`/`truncate` of its own — a caller may pipe into it or
   * call those directly, and this package does both. A fake that were only a
   * `WritableStream` fails the direct calls with "write is not a function",
   * which is a fault in the fake rather than in the code under test.
   *
   * The writer is acquired lazily, because taking one up front would lock the
   * stream and `pipeTo` would refuse it.
   */
  async createWritable(): Promise<FileSystemWritableFileStream> {
    const chunks: Uint8Array[] = [];
    const stream = new WritableStream<Uint8Array | BlobPart>({
      write: async (chunk) => {
        if (chunk instanceof Uint8Array) chunks.push(chunk);
        else if (chunk instanceof Blob) chunks.push(new Uint8Array(await chunk.arrayBuffer()));
        else if (chunk instanceof ArrayBuffer) chunks.push(new Uint8Array(chunk));
        else throw new TypeError("unsupported chunk");
      },
      close: () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        this.data = out;
      },
    });

    let writer: WritableStreamDefaultWriter<Uint8Array | BlobPart> | undefined;
    const extras = {
      write: async (chunk: Uint8Array | BlobPart) => {
        writer ??= stream.getWriter();
        await writer.write(chunk);
      },
      close: async () => {
        writer ??= stream.getWriter();
        await writer.close();
      },
      seek: async () => {},
      truncate: async () => {},
    };
    return Object.assign(stream, extras) as unknown as FileSystemWritableFileStream;
  }
}

class FakeDirectory {
  readonly kind = "directory" as const;
  private children = new Map<string, Entry>();

  constructor(
    readonly name: string,
    /** Resolve names as a case-folding host does — WebKit's OPFS on macOS. */
    private readonly folds = false,
  ) {}

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this;
  }

  /** The entry a name opens, and the name it is stored under. */
  private find(name: string): [string, Entry] | undefined {
    const exact = this.children.get(name);
    if (exact) return [name, exact];
    if (!this.folds) return undefined;
    const folded = name.toLowerCase();
    return [...this.children].find(([n]) => n.toLowerCase() === folded);
  }

  async *entries(): AsyncGenerator<[string, Entry]> {
    for (const [name, entry] of this.children) yield [name, entry];
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirectory> {
    const found = this.find(name)?.[1];
    if (found?.kind === "directory") return alias(found, name);
    if (found) throw mismatch(name, "a file is there");
    if (!opts?.create) throw notFound(name);
    const made = new FakeDirectory(name, this.folds);
    this.children.set(name, made);
    return made;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    const found = this.find(name)?.[1];
    if (found?.kind === "file") return alias(found, name);
    if (found) throw mismatch(name, "a directory is there");
    if (!opts?.create) throw notFound(name);
    const made = new FakeFile(name);
    this.children.set(name, made);
    return made;
  }

  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const hit = this.find(name);
    if (!hit) throw notFound(name);
    const [stored, found] = hit;
    if (found.kind === "directory" && !opts?.recursive) {
      let empty = true;
      for await (const _ of found.entries()) {
        void _;
        empty = false;
        break;
      }
      if (!empty) throw new DOMException(`${name} is not empty`, "InvalidModificationError");
    }
    this.children.delete(stored);
  }

  /** Every path in the tree, for asserting on the shape a write produced. */
  async paths(prefix = ""): Promise<string[]> {
    const out: string[] = [];
    for (const [name, entry] of this.children) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "file") out.push(path);
      else out.push(...(await entry.paths(path)));
    }
    return out.sort();
  }
}

const notFound = (name: string, why = "no such entry") =>
  new DOMException(`${name}: ${why}`, "NotFoundError");

/** What a browser throws for the right name and the wrong kind. */
const mismatch = (name: string, why: string) =>
  new DOMException(`${name}: ${why}`, "TypeMismatchError");

/**
 * A fake root, typed as the handle the filesystem takes.
 *
 * Case-sensitive unless `folds`, as Chromium's and Firefox's OPFS are. WebKit's
 * folds, following the disk on macOS; the e2e suite found that, and `folds`
 * is here so the resolver is tested against both.
 */
export function fakeDirectory(
  name = "root",
  opts: { folds?: boolean } = {},
): FileSystemDirectoryHandle & {
  paths(): Promise<string[]>;
} {
  return new FakeDirectory(
    name,
    opts.folds ?? false,
  ) as unknown as FileSystemDirectoryHandle & {
    paths(): Promise<string[]>;
  };
}
