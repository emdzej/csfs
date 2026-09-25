# csfs in real browsers

Playwright tests that run the built libraries in Chromium, Firefox and WebKit.
Private; not published.

```sh
pnpm e2e                                   # build, then every engine
pnpm --filter @emdzej/csfs-e2e test --project webkit
pnpm --filter @emdzej/csfs-e2e exec playwright install   # first time only
```

Global setup builds a fixture tree — real archives, a real manifest — and a
harness page that puts the libraries on `window.csfs`, then serves both from
local hosts that each misbehave in one documented way: honouring `Range`,
ignoring it, answering everything with HTML, gzipping the manifest, and a
second origin with and without `Access-Control-Expose-Headers`. The built demo
is served too, and driven like a person would.

What is here is what Node cannot tell you: `fetch` called with the wrong
`this`, CORS headers a page cannot read, streams and signals as engines really
implement them, and OPFS as each engine has it. OPFS tests use a persistent
profile per test, because WebKit gives an ephemeral one no OPFS — as Safari's
private browsing does.

Found by it, and fixed:

- **WebKit's OPFS folds case** on macOS, following the disk, and a handle opened
  by an alias names itself as asked while `isSameEntry` denies it is the stored
  entry. `fsa` took that alias for an exact match and answered with the
  caller's spelling. It now checks against a listing, and learns that the host
  folds.
- **Firefox's `persist()` waits on a prompt**, forever when nobody answers.
  `persist({ signal })` bounds it.
- **Firefox and WebKit have no handle permission API**, which `queryAccess`
  read as "no access" for an OPFS handle it could read and write.

Still not covered: a directory chosen with `showDirectoryPicker`, which needs a
person. `fsa` is tested over OPFS handles instead — the same interface.
