# @emdzej/csfs-manifest

The manifest format that lets a tree on a static host describe itself, and the
builder that produces one.

```ts
import { buildManifest, formatManifest } from "@emdzej/csfs-manifest";
import { nodeFileSystem } from "@emdzej/csfs-node";

const manifest = await buildManifest(nodeFileSystem("./data"), {
  label: "my tree",
  builtAt: new Date().toISOString(),
});
await writeFile("./data/csfs-manifest.json", formatManifest(manifest));
```

From a terminal, that is
[`@emdzej/csfs-cli`](https://www.npmjs.com/package/@emdzej/csfs-cli). In a
browser, the [demo](https://csfs.emdzej.pl) does it from a picked folder — the
builder takes any `CsFileSystem`, so the same code runs in both.

## Why it exists

**HTTP cannot list a directory.** A static host serves any file you name and
tells you nothing about what is there. `@emdzej/csfs-http` needs to answer
`directory()` and to know a file's size before it can range-request it, and
neither is discoverable. So the tree carries the answer.

The other backends need no manifest; they can list for themselves.

## The format

```json
{
  "csfs": 1,
  "label": "my tree",
  "builtAt": "2026-09-03T10:00:00.000Z",
  "files": { "/pr/index.dat": 40960, "/drawings.zip": 991232000 },
  "archives": [{ "archive": "/drawings.zip", "serves": "/drawings", "entry": "basename" }]
}
```

**Flat, not nested**, for three reasons: a lookup is one map hit rather than a
fetch per directory level; paths in a real tree share long prefixes and so
compress well; and directories can be _derived_ from the paths, which is what
lets an archive stand in for a directory that is not on disk at all.

`archives` is how a tree declares what it keeps packed, ready to hand to
`withTransparentArchives`. On a real tree, keeping nine vendor archives packed
removed **184,610 files** while serving the same bytes.

`builtAt` is supplied by the caller and omitted when absent — a builder should
not invent a timestamp, and a deterministic build wants to leave it out.

## What it costs

Measured on a real tree: **43,915 entries describing 15.30 GB come to 4.02 MB
of JSON, 0.42 MB gzipped** — 9.4:1, at a host's default level. Paid once, when the tree is opened.

Extracting that tree's nine archives serves the same bytes from 228,515 paths,
and the manifest becomes 14.72 MB — 1.68 MB gzipped. A manifest is priced in
paths, not bytes, which is the argument for declaring an archive rather than
unpacking it.

Worth it at that scale and irrelevant for a dozen files — but a tree in the
millions would want something other than JSON, and this format does not pretend
otherwise. Use `filter` to leave out what no one will ask for:

```ts
await buildManifest(fs, { filter: (path) => !path.endsWith(".tmp") });
```

## `ManifestIndex`

`parseManifest` validates unknown JSON into a `Manifest` — it is reading a file
off the network, so the shape is checked rather than asserted. `ManifestIndex`
wraps one for lookups: `size(path)`, `hasFile`, `hasDirectory`, and
`entriesOf(dir)`, with the directory structure derived once on construction so
listing a directory does not scan every path.

## Licence

**MIT** — see [LICENSE](https://github.com/emdzej/csfs/blob/main/LICENSE).
