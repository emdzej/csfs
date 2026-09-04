# Working on csfs

A read API over data a browser can reach: static HTTP, a picked directory,
OPFS, and inside zip archives in any of those. `README.md` says what it does;
this says how to work on it without undoing decisions that were made for a
reason.

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
  whole body. Using that as the requested slice returns the wrong bytes with no
  error at all, which is the worst possible failure, so it is refused.

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
  so the mistake passes every server-side test and fails only in a tab.
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
  `getFile()` per entry, so it does not do one; `walk` asks the file when a size
  is actually wanted. Do not treat 0 as empty.

## Repository facts

- **PolyForm Noncommercial 1.0.0.** It cannot import or copy GPL code.
- **No data in the repository.** Tests build their own fixtures — including
  their archives, with `zip.js`, so a fixture is a real archive rather than a
  hand-rolled byte array that might not resemble one.
- `@emdzej/csfs-*` is the package prefix. `csfs-cli` is private; the libraries
  are publishable.

## Known gaps

- **No caching layer yet.** `bimmerz-core`'s `vfs` has one — OPFS and IndexedDB
  with conditional GETs, ETags and staleness — and it belongs here as
  `@emdzej/csfs-cache`, as a decorator over any backend.
- **No writer for archives.** Reading is done; building one is not, so a tree
  cannot be _packed_ by csfs.
- **The browser backends have no browser tests.** `fsa` and `opfs` are
  typechecked and exercised through the shared code, but nothing drives a real
  directory picker — that needs interaction a headless run cannot supply.
- **`bimmerz-core` still has its own `vfs`.** The intent is for it to depend on
  csfs instead; nothing here should depend on it.

## Commit messages

Say what changed and _why_, including the mistake that motivated it. If a
number justified the change, quote it. If a claim turned out to be too strong,
say what the measurement was.
