# @emdzej/csfs-opfs

The origin private file system, as a csfs file system. Private to your origin,
writable, and — the reason to use it — **it never prompts**.

```ts
import { opfsFileSystem, isOpfsSupported, quota } from "@emdzej/csfs-opfs";

const fs = await opfsFileSystem({ namespace: "my-app" });
await fs.write("/pr/index.dat", bytes);
await fs.read("/pr/index.dat"); // after a reload, with no click
```

Supported in every current browser, unlike the directory picker.

## Why import into it

A picked directory is the obvious way to read local data, but its permission
does not survive a reload: the handle comes back, the grant does not, and
re-requesting it needs a user gesture. So "open the app and it just works" is
not achievable that way.

OPFS has no such gate. Copying a tree in once buys silent access from then on —
which is the whole trade: one import, and no prompt ever again.

```ts
import { walkFileSystem } from "@emdzej/csfs-core";

for await (const entry of walkFileSystem(source, "/")) {
  const file = await source.file(entry.path);
  if (file) await target.write(entry.path, await file.bytes());
}
```

## What it costs

**It is evictable.** The browser may reclaim it under storage pressure unless
you ask:

```ts
import { persist } from "@emdzej/csfs-opfs";
await persist(); // true if granted
```

**It is shared across the whole origin.** Two features writing `/data` collide,
so `namespace` puts each in its own subtree. `clearNamespace(name)` removes one
without touching the others.

**Check the budget before a large import.** `quota()` returns `usage` and
`quota`; a 15 GB tree will not fit where the browser offered 2 GB, and finding
that out at file 40,000 is worse than finding it out at zero.

**Writing through the handle API stages to a temporary file and swaps on
close**, so write traffic roughly doubles. Avoidable with
`createSyncAccessHandle` inside a worker, which is the right move for a bulk
import.

## Relationship to `csfs-fsa`

OPFS _is_ the File System Access API, pointed at a browser-managed root, so this
package is a thin wrapper: `opfsFileSystem` resolves the root, applies the
namespace, and returns the same `FsaFileSystem` (re-exported here as
`OpfsFileSystem`). The extras — `persist`, `quota`, `clearNamespace` — are the
parts that have no analogue for a picked directory.

## Licence

**MIT** — see [LICENSE](https://github.com/emdzej/csfs/blob/main/LICENSE).
