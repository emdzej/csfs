# Changelog

Notable changes, newest first. All eight packages share one version, because
they are released together and a consumer should not have to work out which
combination is coherent.

Versions follow [semantic versioning](https://semver.org/). Before 1.0 a minor
bump is where features land.

## 0.2.0

Everything here came out of evaluating csfs as a replacement for
`@emdzej/bimmerz-vfs`, which is PolyForm Noncommercial where this is MIT. Four
of the five items are things that abstraction had and this one did not.

### Added

- **`caseInsensitive` on `csfs-http`.** Real data sets are inconsistent about
  case: a BMW install rsynced off Windows onto a Linux host holds
  `EDIABAS/Ecu/MS43.PRG` while every reference in the data says `ms43.prg`, and
  on Windows both worked. Implemented in `ManifestIndex` as one lower-cased map
  over paths already in memory, so it costs no extra request — which is why it
  is affordable here and expensive on a handle-backed backend.

  Colliding paths resolve by sorted order, not by JSON key order: a manifest
  rebuilt from the same tree has to resolve identically to the one it replaced,
  or a lookup starts depending on when the manifest was written. `caseCollisions`
  reports the groups, and `csfs manifest` prints them.

  Not added to `csfs-node`: the host filesystem has already decided (APFS and
  NTFS fold, ext4 does not) and a second layer would only disagree with it.

- **`ranges: "auto" | "require" | "never"` on `csfs-http`**, default `"auto"`.
  A host that ignores `Range` answers 200 with the whole file; that body is
  still never used _as_ the slice, but it is now sliced locally instead of
  refused, and the header stops being sent once the host has shown it ignores
  it. `rangesSupported` reports which of the two is happening.

  The refusal was right about the hazard and wrong about the remedy. The
  bimmerz dongle's static handler parses no `Range` at all and answers 200
  chunked (`http_static.c:send_file`), so refusing made a whole deployment
  unreadable when a correct answer was available. `"require"` keeps the old
  behaviour for a consumer that would rather fail than download 945 MB to read
  64 KB of it.

  `wholeFileCacheBytes` (default 16 MiB) keeps the most recent whole body,
  because one archive read is several slices of the _same_ file — its end, then
  its central directory, then an entry — and without it a no-`Range` host would
  serve the whole archive once per slice.

- **`csfs manifest --ignore <file>`**, gitignore-style, with
  `<dir>/.csfsignore` picked up without being asked for. Patterns **prune**
  rather than filter — `buildManifest` grew a `prune` option for it — because
  an ignored subtree that is still walked costs the walk, which is the whole
  expense on a tree where the ignored part is the big part. `.csfsignore` joins
  `csfs-manifest.json` in never being described.

- **`-i, --case-insensitive` on `csfs ls` and `csfs cat`**, so the option is
  reachable from a terminal rather than only from a consumer.

- **Tests for `csfs-manifest` and `csfs-node`**, which had none.

### Fixed

- **A lookup answered with the name it was asked for, not the name on disk.**
  All four backends built the returned `CsFile` from the caller's argument, so
  under `caseInsensitive` asking for `/ecu/ms43.prg` on a store holding
  `MS43.PRG` gave back `file.name === "ms43.prg"`.

  A wrong answer shaped like a right one, and load-bearing: bimmerz hands
  `file.name` to ediabasx, which pins `prgPath` and `VARIANTE` by it, so a
  lowercased variant name fails several layers from the lookup that caused it.
  `fsa` now threads the resolved segment through its resolvers, `zip` rebuilds
  the path from the walked nodes, and `http` routes through
  `ManifestIndex.canonical` — which also means the _URL_ fetched is the one the
  manifest records.

- **`csfs-zip`'s `stat` disagreed with its own `file`.** It went through
  `statVia`, which matches a parent's listing by exact name, so it reported a
  path absent that `file()` would happily read whenever the archive was opened
  case-insensitively. It now walks to the node, which is also cheaper.

- **`csfs-fsa` could not remove a file whose case differed** from the path
  asked for. `removeEntry` takes a literal name, so `remove("/ecu/ms43.prg")`
  silently removed nothing where the disk held `MS43.PRG` — the one case the
  option exists to handle. Same family as the 0.1.1 fix, and found by looking
  for the rest of it.

- **`csfs-fsa` cached a directory miss forever**, so `directory(p)` kept
  answering null after `makeDirectory(p)` had already succeeded. Misses are now
  dropped once they settle; they are still shared while in flight, which is
  what makes concurrent lookups take one walk instead of racing.

- **`csfs-fsa` kept a stale handle after a removal.** The cache is keyed by the
  path as _asked for_, so `/Ecu` and `/ecu` are two keys for one directory, and
  deleting only the caller's spelling left the other pointing at something gone.

- **`csfs-node` dropped every symlink from a listing.** `readdir` does not
  follow, so a symlink is neither `isFile()` nor `isDirectory()` and testing
  only those two skipped it — while `fs.stat` _does_ follow, so `file()` could
  read a path `entries()` had never mentioned. Since `buildManifest` walks
  listings, a symlinked file was absent from every manifest the CLI wrote.
  Symlinks are now classified by their target, and a broken one is listed at
  size 0 rather than vanishing.

- **Read errors on the HTTP path said the wrong thing.** Any non-206 was
  `RangeUnsupportedError`, which sent you to check a server config that was
  fine. A 416 now says the manifest and the host disagree about the file's
  length — a stale manifest — and other statuses are a `BackendError` naming
  the status.

- **`csfs --version` reported 0.1.0 at 0.1.1.** It is read from
  `package.json` now, which is the only thing a hand-maintained version string
  reliably gets wrong.

### Compatibility with 0.1.1

Checked rather than asserted.

- **The API is additive.** A consumer written against the whole of 0.1.1's
  surface compiles clean against 0.2.0 under `strict`,
  `exactOptionalPropertyTypes` and `skipLibCheck: false`. Everything new is an
  optional option, a new member, or a type: `ManifestIndex`'s second constructor
  argument is optional, and no runtime export was removed or added.
- **The manifest format is unchanged**, still `csfs: 1`. Verified both ways on a
  real 13,048-file manifest: 0.1.1 reads one written by 0.2.0's CLI, and 0.2.0
  reads a 0.1.1-shaped one. `csfs-core`'s source is byte-identical to 0.1.1.
- **Install the set.** `workspace:*` packs to an exact `0.2.0`, so `csfs-http`
  pulls `csfs-manifest` 0.2.0 with it — which it needs, for `canonical()`.

Three behaviour changes are observable, which is what a pre-1.0 minor is for:

- A host that ignores `Range` used to throw and now reads correctly. Strictly
  more permissive; it breaks only code that relied on the throw. Use
  `ranges: "require"` to keep the old behaviour.
- A read that 404s or 416s used to be `RangeUnsupportedError` and is now a
  `BackendError`. Catching the base class is unaffected — `RangeUnsupportedError`
  extends it.
- `file.name` and `file.path` under `caseInsensitive` now report the stored
  casing rather than the caller's. That is the fix above, and it only reaches
  `fsa`, `opfs` and `zip`, since `http` had no such option to be wrong about.
  A name read from `entries()` was always the stored one and has not changed.

Consumers pinned at `^0.1.1` will not see any of it until they ask: a caret on
a `0.x` version allows patches only.

### Decided against

- **Per-directory manifests.** Measured rather than argued: on a 13,048-file
  BMW install, one flat manifest is 99 kB gzipped in a single request against
  110 kB spread over 165 per-directory indexes — _larger_ in total, because a
  directory's paths no longer share a compression window with the rest of the
  tree. Per-directory wins only when a consumer touches a small part of a tree,
  and loses the two things that matter more: a lookup costs a round trip per
  path level, and directories can no longer be derived, so an archive cannot
  stand in for one. If manifest size ever does bite, sharding a flat manifest at
  declared subtrees gets the laziness without either loss.

## 0.1.1

### Fixed

- **`csfs-fsa` could not create a directory when opened case-insensitively**, so
  every write to a nested path failed. `dir(path, create)` resolves each path
  segment with `findChild`, which returns null for a directory that is not there
  yet — and `dir` then returned null instead of creating it. `fileHandle` has
  the fallback that `dir` was missing (`?? (create ? name : null)`).

  The shape of the failure is worth recording, because it is why this survived:
  `write` throws `${path}: could not be created` naming the _file_, with nothing
  to suggest the parent was the problem, and a consumer copying a tree sees no
  bytes arrive rather than an error it can act on. It was found by watching
  `navigator.storage.estimate()` stay flat while a copy claimed to be running.

  This affects `csfs-opfs` too, since it is the FSA backend underneath: an OPFS
  filesystem opened with `caseInsensitive: true` was read-only in practice for
  anything below the root.

### Added

- **Tests for `csfs-fsa`**, which had none — the File System Access API does not
  exist in Node. `fake-directory.ts` is an in-memory stand-in for
  `FileSystemDirectoryHandle`, deliberately literal about the two things a fake
  usually smooths over and that the code under test depends on: names are
  case-sensitive, and `getDirectoryHandle` without `create` _rejects_ with
  `NotFoundError` rather than returning null.

  It also implements `createWritable` as both a `WritableStream` and an object
  carrying `write`/`close`/`seek`/`truncate`, because `FileSystemWritableFileStream`
  is both and this package uses both.

  Four of the seven new tests fail without the fix above.

## 0.1.0

First release. One filesystem interface — `CsFile` is `Blob`-shaped, so
`slice(pos, pos + len).bytes()` is a bounded read — over a picked directory
(`csfs-fsa`), the origin private filesystem (`csfs-opfs`), a zip
(`csfs-zip`), static HTTP with `Range` (`csfs-http`) and `node:fs`
(`csfs-node`), plus a manifest format (`csfs-manifest`) for the HTTP backend,
which cannot list a directory, and a CLI (`csfs-cli`).
