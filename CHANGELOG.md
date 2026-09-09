# Changelog

Notable changes, newest first. All eight packages share one version, because
they are released together and a consumer should not have to work out which
combination is coherent.

Versions follow [semantic versioning](https://semver.org/). Before 1.0 a minor
bump is where features land.

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
