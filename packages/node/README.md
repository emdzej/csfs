# @emdzej/csfs-node

`node:fs` as a csfs file system. For tooling, tests, and anything that prepares
a tree before it is served.

_Part of [csfs](https://github.com/emdzej/csfs) — a **c**lient **s**ide **f**ile **s**ystem: one read API over static HTTP, a picked directory,
OPFS, and inside zip archives._

```ts
import { nodeFileSystem } from "@emdzej/csfs-node";

const fs = nodeFileSystem("./data");
await fs.read("/pr/index.dat");
const file = await fs.file("/drawings.zip");
await file?.slice(0, 1024).bytes(); // one positional read, not a full load
```

Writable, and reads by range — a slice is a positional read, so an archive can
be inspected without loading it.

## What it is for

**Building manifests.** A tree destined for static hosting needs a description
of itself, and the builder is backend-agnostic, so the same code that reads over
HTTP in a browser walks the directory here:

```ts
import { buildManifest, formatManifest } from "@emdzej/csfs-manifest";

const manifest = await buildManifest(nodeFileSystem("./data"), {
  label: "my tree",
  builtAt: new Date().toISOString(),
});
```

**Being the reference in tests.** csfs's parity suite stands up a real HTTP
server over a real directory and compares reads byte for byte against this
backend — whole files, ranges at six offsets, and an archive read in place. Each
backend's own tests only prove it is self-consistent; a backend that dropped the
first byte of every read would pass those happily. This one is the yardstick
because `node:fs` is the implementation least likely to be wrong.

**Confining paths.** Every path is resolved beneath the root given to
`nodeFileSystem`, and `..` cannot walk out of it, so a path assembled from
untrusted input stays inside the tree.

## Notes

- Node 18+, ESM only.
- `stat` reports `kind`, `name`, and `size` — the intersection all backends can
  honour. For anything more, use `node:fs` directly; this is not a replacement
  for it.
- The only backend here that is not for a browser. It exists so the same code
  can run in both, which is what makes the CLI and the web app share a manifest
  builder.

## Licence

**MIT** — see [LICENSE](https://github.com/emdzej/csfs/blob/main/LICENSE).
