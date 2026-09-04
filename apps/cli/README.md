# @emdzej/csfs-cli

Prepare a directory for static hosting, and inspect a tree through any csfs
backend from a terminal.

_Part of [csfs](https://github.com/emdzej/csfs) — a **c**lient **s**ide **f**ile **s**ystem: one read API over static HTTP, a picked directory,
OPFS, and inside zip archives._

```sh
npx @emdzej/csfs-cli manifest ./data --label "my tree"
```

No install needed for one-off use.

## `manifest` — describe a directory

**HTTP cannot list a directory**, so a tree served over static HTTP carries a
description of itself. This writes it:

```sh
csfs manifest ./data --label "my tree" --pretty
csfs manifest ./data -o ./public/csfs-manifest.json
csfs manifest ./data --dry-run          # print the summary, write nothing
```

Then serve the directory from anywhere — S3, GitHub Pages, nginx — and read it
with [`@emdzej/csfs-http`](https://www.npmjs.com/package/@emdzej/csfs-http).

### Archives read in place

A large archive can stay packed and answer for a directory that is not on disk:

```sh
csfs manifest ./data \
  --archive "/drawings.zip:/drawings:basename" \
  --archive "/images_1.zip:/images"
```

The spec is `<archive>:<serves>[:basename]`, and it is repeatable — several
archives may serve one directory, which is how a multi-disc data set is
described without renaming anything.

`basename` matters when the archive and the extracted layout are **different
shapes**: a flat `drawings.zip` standing in for a tree bucketed by name, where
`/drawings/1132/1132C000.png` must find entry `1132C000.png`. Only you know
which it is, so it is declared rather than guessed. Default is `relative`.

Without `--archive`, an archive is just a file in the manifest — still readable
via `#`, but nothing stands in for a directory. On a real tree, declaring nine
archives removed **184,610 files** while serving the same bytes.

## `ls` and `cat` — look at a tree

Both take a local directory _or_ an `http(s)` URL, which is what makes them
useful for checking a deployment actually works:

```sh
csfs ls ./data /pr
csfs ls https://data.example.test /pr -R
csfs cat https://data.example.test /pr/index.dat | xxd | head

# and inside an archive, over the network, without downloading it
csfs cat https://data.example.test "/drawings.zip#/1132C000.png" > out.png
```

That last one is the thing worth trying after a deploy: if it works, the host
honours `Range` and the manifest is correct. If the host silently ignores
`Range`, csfs says so rather than handing back the wrong bytes.

## Prefer not to install Node?

The [demo app](https://csfs.emdzej.pl) builds a manifest from a folder you pick
in the browser and downloads the result. Same builder, no toolchain.

## Licence

**MIT** — see [LICENSE](https://github.com/emdzej/csfs/blob/main/LICENSE).
