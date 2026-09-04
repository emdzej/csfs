# @emdzej/csfs-fsa

A directory the user picked, as a csfs file system. File System Access API,
so Chromium-only.

```ts
import { pickDirectory, fsaFileSystem, isFsaSupported } from "@emdzej/csfs-fsa";

if (isFsaSupported()) {
  const handle = await pickDirectory("read");
  const fs = fsaFileSystem(handle);
  await fs.read("/pr/index.dat");
}
```

Reads are backed by real `File` objects, so slicing costs nothing and never
touches the network. Writable if you ask for `"readwrite"`.

## Two things that will bite you

**Permission does not survive a reload.** A handle can be stored in IndexedDB
and comes back intact, but `queryPermission` reports `"prompt"` afterwards, and
`requestPermission` only works inside a user gesture. So a remembered directory
needs one click — it cannot be re-granted on boot. `queryAccess` and
`requestAccess` let you tell that apart from a real failure, which is the
difference between showing a button and showing an error:

```ts
if (!(await queryAccess(handle))) {
  // inside a click handler, not on load
  if (!(await requestAccess(handle))) return showPicker();
}
```

If you want no prompt at all, import into
[`@emdzej/csfs-opfs`](https://www.npmjs.com/package/@emdzej/csfs-opfs) instead.

**There is no path lookup in the API.** Only "get a child of this directory", so
each path segment is a round trip. Resolved directories are cached, which makes
the second read from a deep directory much cheaper than the first.

Writing also stages to a temporary file and swaps on close, so write traffic
roughly doubles. OPFS can avoid that with `createSyncAccessHandle` in a worker.

## Picking a zip instead

```ts
import { pickArchive } from "@emdzej/csfs-fsa";
import { withArchives, zipFromBlob } from "@emdzej/csfs-zip";

const fs = withArchives(zipFromBlob(await pickArchive()));
```

For browsers without the pickers, `<input type="file">` works everywhere — a
picked `File` is a `Blob`, which is all `zipFromBlob` asks for.

## Licence

**PolyForm Noncommercial 1.0.0** — see the
[repository](https://github.com/emdzej/csfs).
