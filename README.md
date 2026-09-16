# csfs

**C**lient **S**ide **F**ile **S**ystem.

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

## Case

Real data sets are inconsistent about case. A BMW install rsynced off Windows
onto a Linux host holds `EDIABAS/Ecu/MS43.PRG` while every reference in the
data says `ms43.prg`, and on Windows both spellings worked.

```ts
const fs = httpFileSystem(base, { caseInsensitive: true });
const file = await fs.read("/ediabas/ecu/ms43.prg"); // found
```

Off by default, because two files differing only in case then become ambiguous
and a consistent tree should not pay for the ambiguity. Available on `http`,
`fsa`, `opfs` and `zip` — not on `node`, where the host filesystem has already
decided (APFS and NTFS fold; ext4 does not) and a second layer of folding would
only disagree with it.

**A lookup answers with the name as stored, not as asked for.** `file.name` for
the read above is `MS43.PRG`. That matters because the name gets passed on:
ediabasx pins a variant by it, so echoing the caller's own spelling back would
be a wrong answer that looks like a right one.

What it costs differs by backend, which is why it is per-backend rather than one
global switch. On `http` and `zip` it is one extra in-memory map, built from
data already loaded — effectively free. On `fsa` and `opfs` there is no path
lookup in the API at all, so it means listing a directory per segment.

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
archives. Flat because a lookup is then one map hit rather than a fetch per
directory level, because paths in a real tree share long prefixes and compress
well, and because directories can be _derived_ — which is what lets an archive
stand in for a directory that is not on disk.

Measured on a real tree: **43,915 entries describing 15.30 GB come to 4.02 MB
of JSON, 0.42 MB gzipped** — 9.4:1, at a host's default level. That is the cost, and it is paid once when the tree
is opened — worth it at that scale, and irrelevant for a tree of a dozen files,
but a tree in the millions would want something smarter than JSON.

That tree keeps nine archives packed. Extracted, the _same bytes_ need 228,515
entries and the manifest grows to 14.72 MB — 1.68 MB gzipped. Declaring an
archive is what makes the difference, because paths are what a manifest costs,
not bytes.

Per-directory indexes were measured against this rather than assumed. On a
13,048-file BMW diagnostic install, one flat manifest is **99 kB gzipped in a
single request**; one index per directory is **110 kB across 165 files** —
_larger_ in total, because a directory's paths no longer share a compression
window with the rest of the tree. Per-directory wins only when a consumer
touches a small part of the tree, and loses the two things that matter more: a
lookup costs a round trip per path level, and a directory can no longer be
derived, so an archive cannot stand in for one. Sharding a flat manifest at
declared subtrees would be the way to get the laziness without either loss.

`--ignore <file>` takes gitignore-style patterns, and `<dir>/.csfsignore` is
picked up without being asked for. Patterns **prune** rather than filter: an
ignored directory is never walked, which is the difference between describing
200,000 files and reading them. `csfs-manifest.json` and `.csfsignore` are
never described — a manifest that carries its own size is wrong the moment it
is written.

After building, any paths that differ only in case are reported. They are
reachable only one at a time by a consumer reading case-insensitively, and a
tree that quietly hides a file looks exactly like one that never had it.

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

- **HTTP** — one `Range` request per read, and needs a manifest. A host that
  ignores `Range` answers 200 with the whole file, so that body is never used
  as the slice; it is sliced locally instead, and the header stops being sent.
  Reads keep working, but each one costs a whole file — `rangesSupported` says
  which of the two is happening, and `ranges: "require"` fails instead for a
  consumer that would rather not download 945 MB to read 64 KB.
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

## Support

If you find this project useful, consider [buying me a coffee](https://buymeacoffee.com/emdzej) ☕ or [sponsoring on GitHub](https://github.com/sponsors/emdzej) or if it's your thing: via PayPal

[![Donate with PayPal](https://www.paypalobjects.com/en_US/PL/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/donate/?business=TDBR3A97PLQRQ&no_recurring=0&item_name=%28emdzej%29&currency_code=PLN)

## Licence

**MIT** — see [`LICENSE`](LICENSE).
