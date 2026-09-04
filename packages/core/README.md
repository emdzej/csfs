# @emdzej/csfs-core

The contract every csfs backend implements, plus the pieces they all need:
paths, two `CsFile` implementations, MIME lookup, and a tree walker.

_Part of [csfs](https://github.com/emdzej/csfs) — a **c**lient **s**ide **f**ile **s**ystem: one read API over static HTTP, a picked directory,
OPFS, and inside zip archives._

You rarely install this alone — a backend package pulls it in. Install it
directly when you are writing a backend, or when you want to accept "any csfs
file system" as a parameter type.

```ts
import type { CsFileSystem } from "@emdzej/csfs-core";

async function loadIndex(fs: CsFileSystem) {
  const file = await fs.file("/pr/index.dat");
  if (!file) return null; // absence is `null`, not a throw
  return await file.slice(0, 4096).bytes(); // 4 KB, wherever it lives
}
```

That function works unchanged against HTTP, a picked directory, OPFS, a zip
archive, or `node:fs`.

## The interface

```ts
interface CsFileSystem {
  readonly kind: string; // "http", "fsa+zip", … — for diagnostics
  file(path: string): Promise<CsFile | null>;
  directory(path: string): Promise<CsDirectory | null>;
  read(path: string): Promise<Uint8Array | null>;
  stat(path: string): Promise<CsStat | null>;
}
```

**A file is modelled on `Blob`** — `size`, `type`, `slice`, `bytes`,
`arrayBuffer`, `stream`, `text`. Reading _part_ of a file is the operation that
makes remote data usable: an archive is read from its end, a sorted index is
binary-searched, a video is seeked. An interface whose only read is "give me the
whole thing" forces a full download per lookup. Because `Blob` and `File`
already have this shape, the local backends need no adapter at all.

**Absence returns `null`.** Checking whether something exists needs no
`try`/`catch`. Errors are for a caller asking something impossible, or a host
misbehaving — which keeps the two apart at the call site.

**Writing is a separate interface.** `WritableFileSystem` adds `write`,
`makeDirectory`, and `remove`. Two of the backends cannot write; folding it into
one interface would make every consumer check capabilities it never uses.

## What is in here

| Export                                                                               | Why                                                                                             |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `BlobFile`                                                                           | a `CsFile` over anything `Blob`-shaped                                                          |
| `RangeFile`                                                                          | a `CsFile` over a `(start, end) => Promise<Uint8Array>` reader; `slice` composes by arithmetic  |
| `bytesFile`, `blobFile`, `toBlob`, `objectUrl`                                       | constructing files and getting a URL for an `<img>`                                             |
| `parsePath`, `formatPath`, `normalizePath`                                           | `#` fragment addressing, and `..` resolved without escaping the root                            |
| `dirname`, `basename`, `extname`, `joinPath`, `segments`                             | path arithmetic that does not import `node:path`                                                |
| `mimeType`, `registerMimeType`                                                       | extension → type, so `file.type` is populated on backends that do not report one                |
| `walk`, `walkFileSystem`, `resolveFile`, `resolveDirectory`, `statVia`               | depth-first iteration, and the shared implementations of "resolve a path one segment at a time" |
| `NotDataError`, `RangeUnsupportedError`, `BackendError`, `UnsupportedOperationError` | the failures worth telling apart                                                                |

`RangeFile` is the one to understand if you are writing a backend: give it a
size and a range reader, and slicing is free — `slice(100, 200).slice(10, 20)`
becomes a single read of bytes 110–120, with no request in between.

## Paths

Always `/`-rooted and `/`-separated, whatever the host uses. A `#` introduces a
path _inside_ an archive, and nests:

```ts
parsePath("/a.zip#/b.zip#/deep.txt");
// { base: "/a.zip", fragments: ["/b.zip", "/deep.txt"] }
```

`normalizePath` collapses `.` and `..` and cannot be walked above the root, so a
path assembled from untrusted input stays inside the tree.

## Licence

**MIT** — see [LICENSE](https://github.com/emdzej/csfs/blob/main/LICENSE).
