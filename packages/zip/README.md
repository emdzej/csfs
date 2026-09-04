# @emdzej/csfs-zip

A zip archive as a file system — read from any backend, by range, without
unpacking it.

_Part of [csfs](https://github.com/emdzej/csfs) — a **c**lient **s**ide **f**ile **s**ystem: one read API over static HTTP, a picked directory,
OPFS, and inside zip archives._

```ts
import { zipFromBlob, withArchives } from "@emdzej/csfs-zip";
import { httpFileSystem } from "@emdzej/csfs-http";

// A picked or dropped file
const fs = withArchives(zipFromBlob(file));
await fs.read("/inside/photo.png");

// Or an archive sitting in another tree, read in place
const http = withArchives(httpFileSystem("https://example.test/data"));
await http.read("/media.zip#/photo.png"); // a few Range requests, not 945 MB
```

Only the central directory and the requested entry are read. Which is the whole
point: a 945 MB archive on a static host becomes browsable in a tab.

## `#` addressing

`withArchives(fs)` makes `#` work on any file system, and nests:

```ts
await fs.read("/pack.zip#/inside.txt");
await fs.read("/outer.zip#/inner.zip#/deep.txt");
```

Paths without a `#` are passed straight through, so wrapping a file system costs
nothing until someone uses the syntax. Archives are opened once and cached —
the expensive part is the central directory, not the reads — and cached as the
_promise_, so two concurrent lookups share one read of it.

## Transparent mounts

`withTransparentArchives(fs, mounts)` makes an archive answer for a directory
that does not exist:

```ts
const fs = withTransparentArchives(base, [
  { archive: "/drawings.zip", serves: "/drawings", entry: "basename" },
]);

await fs.read("/drawings/1132/1132C000.png"); // from a flat archive
```

This is the case that motivated the package. A parts catalogue ships 38,488
drawings as one flat `drawings.zip` _and_ as a tree bucketed by name, and every
reference in the data uses the tree's shape. The archive and the extracted
layout are **different shapes**, and only the tree's author knows how one maps
onto the other — so a mount _declares_ it. `entry: "basename"` is a fact about
that archive, not a default.

Several archives may serve one directory, which is how a multi-disc data set
that ships three different `images_1.zip` files is read without renaming
anything.

**A real file always wins**, so a tree that _was_ extracted keeps working, and a
half-extracted one falls back file by file rather than failing.

## Zip handling is not ours

The reader is [`@zip.js/zip.js`](https://github.com/gildas-lormeau/zip.js). The
format has enough corners to be worth a library: zip64 past 4 GB or 65,535
entries, data descriptors, cp437 entry names, and — the one that catches people
— archives whose _local_ headers carry zero sizes and a zero CRC while the
central directory holds the truth.

What this package supplies is `CsFileReader`, a `zip.js` `Reader` over a
`CsFile`. That one adapter is what lets an archive be read from HTTP, a picked
directory, OPFS, or `node:fs` without any of them knowing about zip.

## Licence

**MIT** — see [LICENSE](https://github.com/emdzej/csfs/blob/main/LICENSE).
