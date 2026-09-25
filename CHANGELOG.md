# Changelog

Notable changes, newest first. All eight packages share one version, because
they are released together and a consumer should not have to work out which
combination is coherent.

Versions follow [semantic versioning](https://semver.org/). Before 1.0 a minor
bump is where features land.

## Unreleased

### Fixed

- **`csfs-http` checked the answer it got against the question it asked.** A
  `206` was taken on trust, so a stale manifest — the host clamping the range
  to the shorter file it had — came back as a short read with no error. A 206
  for another range, a 206 of the wrong length, and a whole body that is not
  the manifest's size are now `BackendError`s naming the stale manifest.
- **An injected `fetch` was still called as a method.** Only the default was
  wrapped, so `{ fetch: window.fetch }` threw "Illegal invocation" in a tab —
  the bug 0.1.0 fixed, reintroduced for anyone who passed their own.
- **Paths were not encoded.** `/a#b.txt` fetched `/a`, `/q?x=1.bin` fetched
  `/q`, and `directUrl` handed out the same wrong URLs. Each segment is now
  `encodeURIComponent`ed, and the parity fixture has a file named for it.
- **The HTML check ran before the status check**, so a 404 page — which is what
  nginx, S3 and GitHub Pages send — was reported as `NotDataError` ("is this
  really a data tree?") instead of a missing file, and a listed `.html` file
  could never be read.
- **A failed manifest fetch was cached for good.** One 503 while opening broke
  the instance for its lifetime.
- **`parseManifest` checked less than it said.** Keys are now normalised — a
  key written `a/b.txt` appeared in its listing but missed on lookup — sizes
  must be non-negative integers, and `archives` is validated.
- `caseCollisions` is empty on a case-sensitive index, as documented; an empty
  manifest has a root.

- **A file read through an archive did not say where it was.** `CsFile.path` is
  documented as the full path, fragment included, but `withArchives` answered
  `file("/d.zip#/sub/y.txt")` with `/sub/y.txt`, and a transparent mount at
  `/a/b` answered `/a/b/sub/y.txt` with `/sub/y.txt`. Both now report the path
  in the surrounding tree, with names as stored.
- **A mount at `serves: "/"` never answered.** The prefix test became
  `startsWith("//")`. Mounts are now matched segment by segment.
- **A mount's parents did not exist.** With a mount at `/a/b` on `node`, `fsa`
  or `opfs`, `/a/b/x` was readable while `directory("/a")` was null and `/` did
  not list `a` — the manifest's old mistake, repeated in the wrapper and hidden
  on `http` because its manifest derives parents. A flat mount's own directory
  was null too.
- **A failed archive open was cached forever, and every failure was reported as
  a corrupt archive.** One transient read error made the archive unreadable for
  the object's lifetime, and `NotDataError` and `RangeUnsupportedError` were
  wrapped into a plain `BackendError`. Failures are dropped from the cache and a
  store's own errors pass through with their type.
- **Mounts ignored `caseInsensitive` when matching `serves`**, and `stat`
  echoed the caller's spelling — the bug 0.2.0 fixed in the backends. A merged
  listing now also counts `Foo.png` on disk and `foo.png` archived as one entry
  when folding.
- **The same archive mounted twice** — flat at one path, relative at another —
  was listed using whichever mount came first.

- **`csfs-node` could not remove an empty directory, and could remove the
  root.** `rm` without `recursive` refuses every directory (`ERR_FS_EISDIR`),
  so the interface's "or an empty directory" failed here while it worked on
  `fsa`; and `remove("/", { recursive: true })` deleted the root itself. Both
  backends now remove an empty directory, refuse the root with
  `UnsupportedOperationError`, and succeed for a path already absent — which
  `node` did and `fsa` did not.
- **`csfs-node` echoed the caller's spelling on a case-folding host.** On APFS
  or NTFS, `file("/ecu/ms43.prg").name` was `ms43.prg` when the disk holds
  `MS43.PRG`. It now answers with the name on disk, for one `realpath` when the
  spelling already matches. Still no folding layer of its own.
- **A symlink loop made a `node` walk recurse until the path was too long**,
  and `buildManifest` recorded every copy. A link to its own directory or an
  ancestor is left out of the listing.
- **`csfs-fsa` reported a lost permission as absence.** Every error was caught,
  so after a reload — every call rejecting with `NotAllowedError` — the tree
  looked empty rather than locked. Only `NotFoundError` and `TypeMismatchError`
  mean null now; a failed write says why (`TypeMismatchError`, quota,
  read-only) instead of a bare "could not be created".
- **`RangeFile.slice` let NaN and fractions through**, making `size` NaN or
  putting a fractional `Range` header on the wire. Offsets are made whole as
  `Blob.slice` makes them.
- `walkFileSystem(fs, "a/b")` yielded paths without their leading slash;
  `node` listed an unreadable directory as empty where `fsa` threw, and called
  a socket a file in `stat` while `file()` would not open it; `stat("/").name`
  is `""` on every backend; `isWritable` checks `remove` too.

### Changed

- **`opfsFileSystem` returns an `OpfsFileSystem` whose `kind` is `"opfs"`**, a
  subclass of `FsaFileSystem`, rather than an `FsaFileSystem` reporting
  `"fsa"`. A namespace may nest, and `clearNamespace` succeeds on a namespace
  that does not exist and refuses an empty one — the whole origin.
- **Case-insensitive `fsa` and `opfs` writes cache the directories they
  resolve**, and start from the deepest known ancestor. `create` bypassed the
  cache, so each write re-listed every segment: measured on the fake, ten
  writes into `/a/b/c` now cost ten listings where they cost forty, and the
  cost no longer grows with depth. `stat` lists a parent once, not twice.
- **Case-insensitive `fsa` and `opfs` keep each directory's listing** as a
  folded index, updated by their own writes and removals, so writing n files
  into one directory lists it once rather than n times. Another writer is
  accounted for where it can be: a read that misses lists again, a folded hit
  checks the exact spelling with one handle call, and a vanished hit drops the
  index.
- **`node` stats a listing's entries concurrently**, 64 at a time, rather than
  one after another.
- **`stat` through a mount reads the central directory, not the entry.** It
  went through `file()`, so asking the size of a 100 MB entry inflated it.
- **An entry is inflated straight into a buffer of its declared size**, instead
  of collecting chunks and copying them, which held every byte twice.
- **Without `Range`, `csfs-http` keeps several bodies, and shares downloads.**
  `wholeFileCacheBytes` is now a budget over the most recently used bodies
  rather than one slot, because several archives serving one directory evicted
  each other on every lookup. Concurrent reads before `"auto"` has latched wait
  for the first probe instead of each downloading the whole file, and two
  slices of one uncached file share one download. Unread bodies are cancelled.

### Removed

- **Core helpers re-exported from other packages**: `segments` from
  `csfs-http`, `sep` and `statVia` from `csfs-node`, and `dirname`,
  `formatPath` and `statVia` from `csfs-zip`. Import them from
  `@emdzej/csfs-core`, which is where they live; `sep` is `node:path`'s. A
  helper reachable from four packages is one whose home nobody can find, and
  `sep` was a platform detail exported from a library whose paths are always
  `/`.

### Packaging

- **Tests are no longer published.** Every tarball through 0.2.0 carried its
  `dist/*.test.js` — and `csfs-fsa` its in-memory fake — importing a `vitest`
  that no consumer has. The package tsconfigs exclude them, `tsconfig.test.json`
  typechecks them, and the release checks no tarball contains one.
- Every package declares `engines: { node: ">=22" }`, which CI now runs
  alongside 24, `sideEffects: false`, and exports `./package.json`.
- `csfs-cli` is published, as the release workflow already did; `AGENTS.md`
  said it was private.

### Tooling

- **`fsa` and `opfs` are in the parity suite.** Only `node` and `http` were
  compared; the handle-backed backends had tests of their name resolution and
  nothing that checked what they read against anything. They now copy a real
  tree through their own `write` into the in-memory fake and match `node` on
  the walk, ranges at six offsets, reads inside an archive, and `stat`.
- The demo deploys after CI passes, not beside it.
- vitest resolves the packages to their sources, so `pnpm test` without a
  build no longer tests the last build of everything else.
- The release installs `npm@11`, not `npm@latest`, in the job that holds the
  publishing credential.

### Apps

- **`csfs cat` and `csfs ls` mount the archives a manifest declares**, as the
  demo does. `csfs cat <url> /drawings/1132/1132C000.png` said "not found" for
  a file the same tree served a browser. A local directory is mounted from its
  manifest when it has one. `--archive` refuses a mode other than `basename`
  or `relative` rather than reading a typo as `relative`.
- **The demo steps into a zip by range**, through `#`, rather than downloading
  it whole into a `Blob`; `..` leads back out. Object URLs are revoked however
  a preview ends, not only when replaced by another image.

### Dependencies

- `@zip.js/zip.js` 2.10 → 2.18, the one runtime dependency that moved.
- Development: vitest 2 → 5, which clears all seven `pnpm audit` advisories
  (one critical, one high); vite 6 → 8 and vite-plugin-svelte 5 → 7 for the
  demo; patch-level prettier, turbo, svelte, ignore; the GitHub Actions to
  their current majors. TypeScript stays on 5.9 and `@types/node` on 22, the
  `engines` floor.

### Added

- **Reads can be cancelled.** `bytes`, `arrayBuffer`, `text` and `read` take an
  optional `{ signal }`. HTTP hands it to `fetch`; zip hands it to the inflater.
  Work shared between readers — a whole-file download, an entry's inflation —
  stops only when every reader waiting on it has aborted, through a new
  `shared()` helper in core. `Blob` and `File` still satisfy `CsFile`: they
  ignore the argument.
- **`csfs-http` streams.** `stream()` on an HTTP file pipes the response body
  instead of reading the whole range first, which for a large range meant
  holding all of it before the first byte reached the caller. The length is
  checked as it passes, so a short body errors the stream rather than ending
  it cleanly, and cancelling the stream aborts the request. `RangeFile` takes
  a `{ read, stream }` source for any backend that can do the same.
- **A stored zip entry is read by range.** An entry stored without
  compression is a range of its archive, so slicing it now slices the archive:
  over HTTP, reading 100 bytes of a stored 200 KB entry reads its local header
  and those bytes, where it used to inflate — copy — all of it. It streams, and
  an archive stored inside an archive is read through both by range. The CRC
  is not checked on that path, since a partial read cannot check it; a local
  header that is not where the central directory says falls back to zip.js.
- A base URL's query string — a presigned or SAS token — is carried onto every
  request.
- A manifest uploaded gzipped without `Content-Encoding` is recognised by its
  magic number and decompressed.

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
