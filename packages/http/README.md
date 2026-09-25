# @emdzej/csfs-http

Read a tree hosted on any static server — S3, GitHub Pages, nginx — by `Range`
request, so a 945 MB archive can be sampled instead of downloaded.

_Part of [csfs](https://github.com/emdzej/csfs) — a **c**lient **s**ide **f**ile **s**ystem: one read API over static HTTP, a picked directory,
OPFS, and inside zip archives._

```ts
import { httpFileSystem } from "@emdzej/csfs-http";

const fs = httpFileSystem("https://example.test/data");

await fs.read("/pr/index.dat"); // whole file
const big = await fs.file("/drawings.zip");
await big?.slice(0, 1024).bytes(); // 1 KB fetched, not 945 MB
```

No server code, no API — just files and a manifest.

## Why a manifest

**HTTP cannot list a directory.** A static host will serve any file you name and
tell you nothing about what is there. So a tree served over HTTP carries a
description of itself at `csfs-manifest.json`, built by
[`@emdzej/csfs-cli`](https://www.npmjs.com/package/@emdzej/csfs-cli) or
[`@emdzej/csfs-manifest`](https://www.npmjs.com/package/@emdzej/csfs-manifest):

```sh
npx @emdzej/csfs-cli manifest ./data --label "my tree"
```

It is fetched once, on the first call — constructing the file system costs no
round trip. If you already have it, hand it over and there is no fetch at all:

```ts
const fs = httpFileSystem(base, { manifest });
```

`describe()` returns it, for a consumer that wants to cache it between visits.

## Three failures it refuses to paper over

Each of these otherwise presents as data that is subtly wrong rather than as an
error, which is much more expensive to debug than a clean failure.

- **A host that ignores `Range`** answers `200` with the whole body. Treating
  that as the requested slice hands back the wrong bytes with no error at all,
  so it never is. By default (`ranges: "auto"`) the body is sliced locally and
  the header is not sent again; `ranges: "require"` raises
  `RangeUnsupportedError` instead, for a consumer that would rather fail than
  download a whole archive to read 64 KB of it; `ranges: "never"` skips the
  probe. `rangesSupported` says which one is happening.
- **A single-page app answers unknown paths with its own HTML and a `200`**, so
  a mistyped base URL looks like a working tree whose files all happen to be
  documents. An HTML content type where data was expected raises `NotDataError`
  — a distinct type from a 404, because the two need opposite handling. A file
  that _is_ HTML is read as one, and a 404 page is a failed read of that file.
- **A host that disagrees with the manifest** about a file's length — a `416`,
  a `206` for a different range or fewer bytes, a whole body of the wrong
  size — is a stale manifest, and raises `BackendError` saying so rather than
  returning a short read.

## Archives

A tree can keep large archives packed and declare them in its manifest, which
`archives()` returns ready for
[`@emdzej/csfs-zip`](https://www.npmjs.com/package/@emdzej/csfs-zip):

```ts
import { withArchives, withTransparentArchives } from "@emdzej/csfs-zip";

const base = httpFileSystem(url);
const fs = withTransparentArchives(withArchives(base), await base.archives());

await fs.read("/drawings/1132/1132C000.png"); // out of drawings.zip, in place
```

That is worth doing: on a real tree, keeping nine vendor archives packed removed
**184,610 files** while serving the same bytes.

## `directUrl`

For an `<img>` or an `<iframe>`, `directUrl(path)` gives the browser the real
URL so it can cache and range-request for itself. It returns `null` for a path
the manifest does not list — deliberately, so a caller that wants to fall back
to an archive gets the chance rather than holding a URL that 404s silently.

## Cost

One `Range` request per read. Requests within a file are independent, so
concurrent reads become concurrent requests — a depth-3 index lookup costs one
round trip's latency rather than three.

Without `Range`, each file is downloaded once and kept while it fits in
`wholeFileCacheBytes` (16 MiB by default), so the several slices that opening
one archive takes cost one download. Concurrent reads share it.

Paths are percent-encoded segment by segment, and a query on the base URL — a
presigned or SAS token — is carried onto every request.

## Licence

**MIT** — see [LICENSE](https://github.com/emdzej/csfs/blob/main/LICENSE).
