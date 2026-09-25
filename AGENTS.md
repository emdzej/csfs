# Working on csfs

**c**lient **s**ide **f**ile **s**ystem — a read API over data a browser can
reach: static HTTP, a picked directory, OPFS, and inside zip archives in any of
those. `README.md` says what it does;
this says how to work on it without undoing decisions that were made for a
reason.

## A case-insensitive filesystem could not be written to

`FsaFileSystem.dir(path, create)` resolves each segment with `findChild`, which
returns null for a directory that does not exist yet. It then returned null
rather than creating it, so with `caseInsensitive: true` every write to a nested
path failed — `csfs-opfs` included, since it is this backend underneath.

Two things to take from it. `fileHandle` had the fallback (`?? (create ? name :
null)`) and `dir` did not, so **the two resolvers have to agree about what
absence means when creating**; if you touch one, read the other. And the failure
was invisible: `write` throws naming the _file_, so a consumer copying a tree
sees no bytes arrive and reads it as slowness. It was found by watching
`navigator.storage.estimate()` stay flat.

`packages/fsa` now has tests, over an in-memory `FileSystemDirectoryHandle` in
`fake-directory.ts`. Keep that fake literal: **case-sensitive names**, and
`getDirectoryHandle` without `create` must _reject_ with `NotFoundError` rather
than return null. A fake that smooths either one over hides exactly the bugs
this layer has.

## Before you finish

- `pnpm check` — build, typecheck, test, formatting. All four.
- If you changed a backend, the **parity** test is the one that matters. Each
  backend's own suite only proves it is self-consistent; a backend that dropped
  the first byte of every read would pass its own tests happily.
- If you added a capability to one backend, either add it to the others or say
  in the interface why it is optional. A method that only sometimes exists is
  worse than one that is honestly optional.

## The contract is `Blob`-shaped on purpose

`CsFile` has `size`, `slice`, `arrayBuffer`, `bytes`, `stream`, `text` — the
same five things a `Blob` gives you, and not by imitation. Reading _part_ of a
file is what makes remote data usable: an archive is read from its end, a
sorted index is binary-searched. An interface whose only read is "the whole
thing" forces a download per lookup and pushes every backend into inventing its
own range API.

Two consequences to preserve:

- **`Blob` and `File` satisfy it as they are.** The local backends need no
  adapter, which is why `BlobFile` is a thin wrapper and not a translation
  layer.
- **`slice` composes by arithmetic, not by fetching.** `file.slice(a,
b).slice(c, d)` must cost nothing until something is read, because a zip
  reader slices its way down through several layers before touching the network
  once.

## Cancelling shared work

A read takes `{ signal }`, and most expensive work is shared between readers —
one download of a file several slices want, one inflation of an entry. Aborting
shared work because one reader left fails the others; never aborting it keeps a
945 MB download going after everyone has gone. `shared()` in core is the
answer: cancelled when the last reader _with_ a signal aborts, never while a
reader without one waits. Use it rather than a bare cached promise when you add
a shared fetch.

## Absence is `null`, not an exception

`file()` and `directory()` return `null` so existence can be tested without a
`try`/`catch`. Errors are for a caller asking something impossible, or a host
misbehaving. Two of those are their own types because they need opposite
handling:

- **`NotDataError`** — a host answered with a web page. A single-page app
  answers any unknown path with its own HTML and a 200, so a mistyped base URL
  otherwise looks like a working tree whose files all happen to be documents. A
  404 means _this file_ is absent, which is normal.
- **`RangeUnsupportedError`** — the host ignored `Range` and sent 200 with the
  whole body. Using that body _as_ the requested slice returns the wrong bytes
  with no error at all, which is the worst possible failure, so it is never
  passed through.

  It is no longer the only answer, though. Refusing was right about the hazard
  and wrong about the remedy: the 200 body **is** the whole file, so slicing it
  locally is also correct, and it is the version that leaves the tree readable.
  `ranges: "auto"` (the default) does that and latches, so the header is not
  sent again; `"require"` keeps the old behaviour for a consumer that would
  rather fail than download 945 MB to read 64 KB; `"never"` skips the probe.
  This error is now reserved for `"require"`, and a non-206 that is _not_ a 200
  — a 404, a 416 — is a `BackendError` saying what actually happened, because
  "the host ignores Range" sends you to check a server config that is fine.

  The measurement that settled it: the bimmerz dongle's static handler
  (`http_static.c:send_file`) parses no `Range` at all and answers 200 chunked,
  so refusing made an entire deployment unreadable over a correctness argument
  that had a correct answer available.

## A lookup answers with the name as stored

Every backend returns the path the _store_ records, not the path it was handed.
Under `caseInsensitive` those differ, and all four backends got it wrong the
same way at first: `file()` resolved `/ecu/ms43.prg` to the handle for
`MS43.PRG` and then built the `CsFile` from the argument, so `file.name` echoed
the caller's own spelling back.

That is a wrong answer shaped like a right one, and it is load-bearing:
bimmerz hands `file.name` to ediabasx, which pins `prgPath` and `VARIANTE` by
it. A lowercased variant name fails several layers away from the lookup that
caused it.

So `fsa` threads the resolved segment through `dir`/`fileHandle` (`Resolved<H>`
carries the handle _and_ its path), `zip` rebuilds the path from the walked
nodes' own names, and `http` routes everything through
`ManifestIndex.canonical`. If you add a resolution path, it has to do the same,
and `stat` has to agree with `file` about it — `zip`'s `stat` went through
`statVia`, which matches a listing by exact name, and so reported absent for a
path `file()` would happily read.

**Case-insensitivity is per-backend on purpose.** It is one in-memory map on
`http` and `zip`, and on `fsa` and `opfs` one listing per directory, kept as an
index that this backend's own writes keep current. Another writer — a second
tab, another program — is the index's blind spot, so only a write trusts a
miss: a read that misses lists again, a folded hit checks the exact spelling
with one handle call, and a hit that has vanished drops the index. Keep those
three if you touch it.
`node` deliberately has none: the host filesystem has already decided (APFS and
NTFS fold, ext4 does not), and a second layer would only disagree with it.

## Archives

- **A mount declares how to name an entry.** `entry: "basename"` versus
  `"relative"` is a fact about a specific archive. A flat `drawings.zip` may
  stand in for a tree bucketed by name — that is a real shipping layout, not a
  corner case — so an entry name cannot be derived by stripping a prefix.
- **Several archives can serve one directory.** A multi-disc data set ships
  `images_1.zip` more than once with different contents; a lookup tries each.
- **A real file wins over an archived one**, so an extracted tree keeps working.
  The exception is _listing_, where both are merged, because a directory that
  exists only inside an archive has no real counterpart.
- **Directory entries are synthesised.** Plenty of archives store no directory
  entries at all, and a tree built only from stored ones would lose every file
  inside them.
- **Do not hand-roll zip parsing.** `@zip.js/zip.js` handles zip64, data
  descriptors, cp437 names, and archives whose _local_ headers carry zero sizes
  and a zero CRC while the central directory holds the truth. csfs supplies a
  `Reader` over a `CsFile` and nothing more.

## The manifest

HTTP cannot list a directory. The format is a **flat map of path to size**, and
the shape was chosen over a nested tree or per-directory indexes because:

- paths in a real tree share long prefixes and gzip very well;
- a lookup is one map hit, where per-directory indexes cost a round trip per
  level;
- directories are **derived**, which is what lets an archive stand in for a
  directory that is not on disk.

An archive-served directory has to be linked into its _parents_, not only given
a bucket of its own — registering only the bucket once made the directory
resolvable but invisible in its parent's listing, which is worse than absence
because nothing looks wrong.

`buildManifest` runs against the interface, so the CLI builds one from
`node:fs` and the web app builds one from a picked directory using the same
code. Keep it that way.

## Things that will bite

- **`fetch` must be bound.** `private readonly fetchImpl: typeof fetch = fetch`
  makes `this.fetchImpl(...)` a _method_ call, so the browser's `fetch` receives
  the object as its `this` and throws "Illegal invocation". Node tolerates it,
  so the mistake passes every server-side test and fails only in a tab. That
  goes for an _injected_ `fetch` as well: wrap it too, because
  `{ fetch: window.fetch }` is the obvious thing for a caller to pass.
- **Check the status before the content type.** A 404 page is HTML, and so is a
  file the manifest lists as `index.html`; neither is a sign the tree is
  elsewhere. `NotDataError` is for a _successful_ answer that is a web page
  where data was expected.
- **Do not cache a rejected promise.** `x ??= load()` keeps a failure for the
  object's lifetime, so one dropped connection breaks it for good. Every cache
  of a load — the manifest, a zip's central directory, a mount — drops a
  failure once it settles.
- **Tests are not built.** Each package's tsconfig excludes `*.test.ts` (and
  `fsa`'s fake), because `files: ["dist"]` published whatever was built, and
  every tarball through 0.2.0 shipped tests importing a `vitest` no consumer
  has. `tsconfig.test.json` typechecks them instead, and vitest resolves
  `@emdzej/csfs-*` to each package's _source_, so a bare `pnpm test` cannot run
  against a stale `dist`. After changing a tsconfig's `include`/`exclude`,
  delete `dist` and build with `turbo run build --force`: `tsc -b` does not
  remove outputs it no longer produces, and turbo will cache them.
- **A directory handle's permission does not survive a reload.** Store the
  handle in IndexedDB — it is structured-cloneable — but expect
  `queryPermission` to say `"prompt"`, and remember `requestPermission` only
  works inside a user gesture. Say so in an interface rather than letting it be
  discovered.
- **OPFS is shared across the origin.** A file system rooted at `/` can see and
  delete another consumer's files. Use `namespace`.
- **`createWritable` doubles write traffic.** It stages to a temp file and swaps
  on close. That is the right default — a crash leaves the old file rather than
  a truncated one — but it is worth knowing before writing gigabytes.
- **A listing may report size 0.** A handle-backed backend would need a
  `getFile()` per entry, so it does not do one; `buildManifest` asks the file
  when a size is actually wanted. Do not treat 0 as empty.
- **Only absence is null.** `fsa` once caught every error, so a directory whose
  permission had lapsed (`NotAllowedError`) listed as empty rather than
  locked. Catch `NotFoundError` and `TypeMismatchError`; let the rest through.

## Repository facts

- **MIT.** Permissive, because this is a library meant to be depended on.
  It still cannot take GPL code: MIT carries no copyleft obligation, so
  importing GPL source would relicense what is downstream of it. Mirror a
  convention if it is the obvious one; never lift the source.
- **No data in the repository.** Tests build their own fixtures — including
  their archives, with `zip.js`, so a fixture is a real archive rather than a
  hand-rolled byte array that might not resemble one.
- `@emdzej/csfs-*` is the package prefix. All eight are published, the CLI
  included (`npx @emdzej/csfs-cli manifest ./data`); only the demo is private.
- **Node 22+.** `engines` says so and CI runs 22 and 24; `fs.openAsBlob` alone
  would allow 19.8, but nothing older than 22 is tested.

## Known gaps

- **No caching layer yet.** `bimmerz-core`'s `vfs` has one — OPFS and IndexedDB
  with conditional GETs, ETags and staleness — and it belongs here as
  `@emdzej/csfs-cache`, as a decorator over any backend.
- **No writer for archives.** Reading is done; building one is not, so a tree
  cannot be _packed_ by csfs.
- **The browser backends have no browser tests.** `fsa` and `opfs` run over
  the in-memory fake, but nothing drives a real directory picker — that needs
  interaction a headless run cannot supply.
- **`RangeFile.stream()` buffers the whole range** before yielding it. HTTP
  could stream `res.body` instead.
- **`bimmerz-core` still has its own `vfs`.** The intent is for it to depend on
  csfs instead; nothing here should depend on it. 0.2.0 closed what was
  blocking that migration — case-insensitive HTTP lookups, names answered as
  stored, a readable tree on a host without `Range`, and symlinks surviving a
  listing. What remains is on the bimmerz side.

- **The manifest is not sharded.** A flat map is fetched whole. Measured on a
  13,048-file tree, one manifest is 99 kB gzipped in one request against 110 kB
  across 165 per-directory indexes, so per-directory is not the answer — but a
  root manifest pointing at sub-manifests for _declared subtrees_ would give
  the same laziness without costing a round trip per path level and without
  losing derived directories. Worth it somewhere in the millions of paths; not
  at thirteen thousand.

## Commit messages

Say what changed and _why_, including the mistake that motivated it. If a
number justified the change, quote it. If a claim turned out to be too strong,
say what the measurement was.
