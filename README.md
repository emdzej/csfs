# csfs

One read API for data that lives somewhere a browser can reach: a static HTTP
host, a directory the user picked, the origin private file system — or inside a
zip archive in any of those.

```ts
import { httpFileSystem } from "@emdzej/csfs-http";
import { withArchives } from "@emdzej/csfs-zip";

const fs = withArchives(httpFileSystem("https://example.test/data"));

await fs.read("/pr/index.dat"); // Uint8Array
await fs.read("/media.zip#/photo.png"); // out of the archive, one Range request
const file = await fs.file("/huge.bin");
await file?.slice(0, 1024).bytes(); // 1 KB fetched, not the file
```

Nothing is downloaded that was not asked for, and the same code runs against
every backend.

## Why the interface looks like this

**A file is modelled on `Blob`.** `size`, `slice`, `arrayBuffer`, `bytes`,
`stream`, `text`. Reading _part_ of a file is the operation that makes remote
data usable at all — an archive is read from its end, a sorted index is
binary-searched, a video is seeked — and an interface whose only read is "give
me the whole thing" forces a download per lookup. Because `Blob` and `File`
already have this shape, the local backends need no adapter.

**Absence is not an error.** `file()` and `directory()` return `null`, so
testing whether something exists needs no `try`/`catch`. Errors are reserved for
a caller asking something impossible, or a host misbehaving.

**Writing is a separate interface.** Two of the backends cannot write; a
combined interface would make every consumer check capabilities it never uses.

## Archives

Two ways in, for two different situations.

**`withArchives(fs)`** makes `#` work, when the caller knows the archive is
there:

```ts
await fs.read("/pack.zip#/inside.txt");
await fs.read("/outer.zip#/inner.zip#/deep.txt"); // nesting works
```

**`withTransparentArchives(fs, mounts)`** makes an archive answer for a
directory that does not exist:

```ts
const fs = withTransparentArchives(httpFileSystem(base), [
  { archive: "/drawings.zip", serves: "/drawings", entry: "basename" },
]);
await fs.read("/drawings/1132/1132C000.png"); // from the flat archive
```

That last case is not exotic. A parts catalogue ships 38,488 drawings as one
flat `drawings.zip` _and_ as a tree bucketed by name, and every reference in the
data uses the tree's shape. The archive and the extracted layout are different
shapes, so a mount **declares** how one maps onto the other — `entry:
"basename"` is a fact about that archive, not a default. Several archives may
serve one directory, which is how a multi-disc data set is read without
renaming anything.

A real file always wins, so a tree that _was_ extracted keeps working, and a
half-extracted one falls back file by file.

Zip handling is `@zip.js/zip.js`, not ours. The format has enough corners to be
worth a library: zip64 past 4 GB or 65,535 entries, data descriptors, cp437
entry names, and — the one that catches people — archives whose _local_ headers
carry zero sizes and a zero CRC while the central directory holds the truth.
csfs supplies a `Reader` over a `CsFile`, which is what lets an archive be read
from any backend by range.

## The manifest

**HTTP cannot list a directory.** A static host will serve any file you name and
tell you nothing about what is there, so a tree served over HTTP carries a
description of itself:

```sh
csfs manifest ./data --label "my tree" --archive "/drawings.zip:/drawings:basename"
```

That writes `csfs-manifest.json`: a flat map from path to size, plus any
archives. Flat because paths in a real tree share long prefixes and gzip
extremely well, because a lookup is then one map hit rather than a fetch per
directory level, and because directories can be _derived_ — which is what lets
an archive stand in for a directory that is not on disk.

The other backends need no manifest; they can list for themselves.

## Packages

| Package                 | What it is                                          |
| ----------------------- | --------------------------------------------------- |
| `@emdzej/csfs-core`     | the contract, paths, `BlobFile`/`RangeFile`, `walk` |
| `@emdzej/csfs-zip`      | archives as a file system, and `#` addressing       |
| `@emdzej/csfs-http`     | static HTTP, manifest-driven, `Range` reads         |
| `@emdzej/csfs-fsa`      | a picked directory (File System Access)             |
| `@emdzej/csfs-opfs`     | the origin private file system                      |
| `@emdzej/csfs-node`     | `node:fs`, for tooling and tests                    |
| `@emdzej/csfs-manifest` | the manifest format and its builder                 |

`@emdzej/csfs-cli` builds manifests and inspects a tree from a terminal.

## What each backend costs

Worth knowing before choosing one.

- **HTTP** — one `Range` request per read. Needs a manifest, and needs the host
  to honour `Range`; a host that ignores it is rejected rather than trusted,
  because its 200 response is the whole file and using that as a slice returns
  the wrong bytes silently.
- **A picked directory** — no path lookup in the API, so each path segment is a
  round trip; resolved directories are cached. **Permission does not survive a
  reload**: a handle can be stored in IndexedDB, but `queryPermission` reports
  `"prompt"` afterwards and `requestPermission` only works inside a user
  gesture. So a remembered directory needs one click; `queryAccess` and
  `requestAccess` let a consumer tell that apart from a failure.
- **OPFS** — no prompt ever, which is the reason to import into it rather than
  keep a handle. But it is evictable unless `persist()` is granted, and it is
  shared across the whole origin, so use a `namespace`.
- **Writing through either handle API** stages to a temporary file and swaps on
  close, so write traffic roughly doubles. OPFS can avoid that with
  `createSyncAccessHandle`, inside a worker.

## Running it

```sh
pnpm install
pnpm build
pnpm test
```

The suite includes a **parity** test that stands up a real HTTP server over a
real directory, builds a manifest with the real builder, and compares reads
byte for byte against the Node backend — whole files, ranges at six offsets,
and an archive read in place. Each backend's own tests only prove it is
self-consistent; a backend that dropped the first byte of every read would pass
those happily.

## Licence

**PolyForm Noncommercial 1.0.0** — see [`LICENSE.md`](LICENSE.md).
