# @emdzej/csfs-http

Read a tree hosted on any static server — S3, GitHub Pages, nginx — by `Range`
request, so a 945 MB archive can be sampled instead of downloaded.

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
  that as the requested slice hands back the wrong bytes with no error at all.
  Anything but `206` raises `RangeUnsupportedError`.
- **A single-page app answers unknown paths with its own HTML and a `200`**, so
  a mistyped base URL looks like a working tree whose files all happen to be
  documents. An HTML content type where data was expected raises `NotDataError`
  — a distinct type from a 404, because the two need opposite handling.
- **A missing `Content-Length`** means the size is unknown, and a zip read from
  its end cannot start. Better said than guessed.

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

## Licence

**PolyForm Noncommercial 1.0.0** — see the
[repository](https://github.com/emdzej/csfs).
