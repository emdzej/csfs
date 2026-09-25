#!/usr/bin/env node
/**
 * `csfs` — build a manifest, and look at a tree through any backend.
 *
 * The manifest command is the reason this exists: a static host cannot list a
 * directory, so a tree served over HTTP has to describe itself, and something
 * has to write that description. The inspection commands are here because the
 * same code paths the browser uses can then be exercised without a browser —
 * which is how a backend bug becomes a failing command rather than a blank
 * page.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { Command } from "@commander-js/extra-typings";
import chalk from "chalk";
import ignore from "ignore";
import { walkFileSystem, type CsFileSystem } from "@emdzej/csfs-core";
import { httpFileSystem } from "@emdzej/csfs-http";
import {
  buildManifest,
  formatManifest,
  ManifestIndex,
  MANIFEST_FILE,
  parseManifest,
  type ManifestArchive,
} from "@emdzej/csfs-manifest";
import { nodeFileSystem } from "@emdzej/csfs-node";
import { withArchives, withTransparentArchives } from "@emdzej/csfs-zip";

/** Where `manifest` looks for ignore patterns when not told otherwise. */
const IGNORE_FILE = ".csfsignore";

/**
 * A URL means HTTP; anything else is a directory.
 *
 * Mounted with the archives the tree's manifest declares, as the demo mounts
 * them. Without that, `csfs cat <url> /drawings/1132/1132C000.png` said "not
 * found" for a file the same tree served to a browser — the one tool meant to
 * show what a client sees, showing something else. A local directory is
 * mounted from its manifest too, when it has one.
 */
async function open(
  source: string,
  opts: { caseInsensitive?: boolean } = {},
): Promise<CsFileSystem> {
  const remote = source.startsWith("http://") || source.startsWith("https://");
  const caseInsensitive = opts.caseInsensitive ?? false;
  let mounts: ManifestArchive[] = [];
  let base: CsFileSystem;
  if (remote) {
    const http = httpFileSystem(source, { caseInsensitive });
    mounts = await http.archives();
    base = http;
  } else {
    base = nodeFileSystem(source);
    const manifest = resolve(source, MANIFEST_FILE);
    if (existsSync(manifest)) {
      mounts = parseManifest(JSON.parse(await readFile(manifest, "utf8"))).archives ?? [];
    }
  }
  const fs = withArchives(base, { caseInsensitive });
  return mounts.length > 0 ? withTransparentArchives(fs, mounts, { caseInsensitive }) : fs;
}

/**
 * A gitignore-style matcher over csfs paths.
 *
 * `ignore` wants a repo-relative path with no leading slash, and a trailing
 * slash to mean "this is a directory" — csfs paths are rooted and carry
 * neither, so the translation happens here rather than at three call sites.
 */
function matcher(patterns: string): (path: string, isDir: boolean) => boolean {
  const ig = ignore().add(patterns);
  return (path, isDir) => {
    const rel = path.replace(/^\/+/, "");
    if (rel === "") return false;
    return ig.ignores(isDir ? `${rel}/` : rel);
  };
}

/*
 * Read from package.json rather than written here. The literal had drifted a
 * release behind, which is the only thing a hand-maintained version string
 * reliably does.
 */
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command("csfs")
  .description("Client-side file system tooling")
  .version(version);

program
  .command("manifest")
  .description("describe a directory so it can be served over static HTTP")
  .argument("<dir>", "directory to describe")
  .option("-o, --out <file>", `where to write it (default: <dir>/${MANIFEST_FILE})`)
  .option("-l, --label <text>", "a name for this tree")
  .option("--pretty", "indent the JSON — larger, but readable in a diff", false)
  .option(
    "--archive <spec...>",
    "an archive to read in place: <archive>:<serves>[:basename|:relative]. " +
      "Repeatable. Without this an archive is just a file.",
  )
  .option(
    "--ignore <file>",
    `gitignore-style patterns to leave out (default: <dir>/${IGNORE_FILE} if present)`,
  )
  .option("-n, --dry-run", "print the summary and stop", false)
  .action(async (dir, opts) => {
    const fs = nodeFileSystem(dir);
    if (!(await fs.directory("/"))) {
      console.error(chalk.red(`${dir}: not a directory`));
      process.exitCode = 1;
      return;
    }

    let ignoreFile = opts.ignore;
    if (!ignoreFile) {
      const candidate = resolve(dir, IGNORE_FILE);
      if (existsSync(candidate)) ignoreFile = candidate;
    } else if (!existsSync(ignoreFile)) {
      console.error(chalk.red(`${ignoreFile}: no such file`));
      process.exitCode = 1;
      return;
    }
    // csfs's own two metadata files are never described. A manifest that
    // carries its own size is wrong the moment it is written, and an ignore
    // file is an instruction to the builder rather than part of the tree.
    const patterns = [`${MANIFEST_FILE}\n${IGNORE_FILE}\n`];
    if (ignoreFile) patterns.push(await readFile(ignoreFile, "utf8"));
    const ignored = matcher(patterns.join("\n"));

    const archives: ManifestArchive[] = [];
    for (const spec of opts.archive ?? []) {
      const [archive, serves, entry, ...rest] = spec.split(":");
      // A typo in the mode is refused rather than read as "relative": a flat
      // archive mounted relative serves nothing, and says nothing about why.
      if (
        !archive ||
        !serves ||
        rest.length > 0 ||
        (entry !== undefined && entry !== "basename" && entry !== "relative")
      ) {
        console.error(
          chalk.red(`--archive ${spec}: expected <archive>:<serves>[:basename|:relative]`),
        );
        process.exitCode = 1;
        return;
      }
      archives.push({
        archive,
        serves,
        ...(entry === "basename" ? { entry: "basename" as const } : {}),
      });
    }

    let last = Date.now();
    const manifest = await buildManifest(fs, {
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      builtAt: new Date().toISOString(),
      ...(archives.length > 0 ? { archives } : {}),
      filter: (path) => !ignored(path, false),
      prune: (path) => ignored(path, true),
      onProgress: (found, path) => {
        if (Date.now() - last < 250) return;
        last = Date.now();
        process.stderr.write(
          `\r${chalk.dim(`${found.toLocaleString()} files  ${path.slice(-60)}`)}    `,
        );
      },
    });
    process.stderr.write("\r");

    const count = Object.keys(manifest.files).length;
    let bytes = 0;
    for (const size of Object.values(manifest.files)) bytes += size;
    const text = formatManifest(manifest, { pretty: opts.pretty });
    console.log(
      `${chalk.bold(count.toLocaleString())} files, ${(bytes / 1e9).toFixed(2)} GB, ` +
        `manifest ${(text.length / 1e6).toFixed(2)} MB`,
    );
    for (const a of archives) {
      console.log(
        chalk.dim(`  archive ${a.archive} serves ${a.serves} (${a.entry ?? "relative"})`),
      );
    }
    if (ignoreFile) console.log(chalk.dim(`  ignoring per ${ignoreFile}`));

    // Reported whether or not anyone asked, because the hazard is not visible
    // from here: a consumer opening this tree with `caseInsensitive` can reach
    // only the first of each group, and a tree that quietly hides a file looks
    // exactly like one that does not contain it.
    const collisions = new ManifestIndex(manifest, { caseInsensitive: true }).caseCollisions;
    if (collisions.length > 0) {
      console.warn(
        chalk.yellow(
          `\n${collisions.length} path${collisions.length === 1 ? "" : "s"} differ only in case. ` +
            `Read case-insensitively, only the first of each group is reachable:`,
        ),
      );
      for (const group of collisions.slice(0, 10)) {
        console.warn(
          chalk.yellow(`  ${group[0]}`) + chalk.dim(` ← ${group.slice(1).join(", ")}`),
        );
      }
      if (collisions.length > 10) {
        console.warn(chalk.dim(`  … and ${collisions.length - 10} more`));
      }
      console.warn("");
    }

    if (opts.dryRun) {
      console.log(chalk.dim("--dry-run: nothing written."));
      return;
    }
    const out = opts.out ?? `${dir.replace(/\/+$/, "")}/${MANIFEST_FILE}`;
    await writeFile(out, text);
    console.log(`written to ${chalk.bold(out)}`);
    console.log(
      chalk.dim(
        "\nServe the directory and point a client at its URL. A host that honours " +
          "`Range` is read a slice at a time; one that does not is read whole files.",
      ),
    );
  });

program
  .command("ls")
  .description("list a path through any backend")
  .argument("<source>", "a directory, or an http(s) URL")
  .argument("[path]", "path within the tree", "/")
  .option("-R, --recursive", "walk the whole subtree", false)
  .option("-i, --case-insensitive", "match names without regard to case", false)
  .action(async (source, path, opts) => {
    const fs = await open(source, { caseInsensitive: opts.caseInsensitive });
    if (opts.recursive) {
      let files = 0;
      let bytes = 0;
      for await (const entry of walkFileSystem(fs, path)) {
        console.log(`${String(entry.size).padStart(12)}  ${entry.path}`);
        files++;
        bytes += entry.size;
      }
      console.log(
        chalk.dim(`\n${files.toLocaleString()} files, ${(bytes / 1e6).toFixed(1)} MB`),
      );
      return;
    }
    const dir = await fs.directory(path);
    if (!dir) {
      // A file, or nothing at all. Saying which is more useful than "not
      // found" for either.
      const file = await fs.file(path);
      if (!file) {
        console.error(chalk.red(`${path}: not found`));
        process.exitCode = 1;
        return;
      }
      console.log(`${String(file.size).padStart(12)}  ${file.path}  ${chalk.dim(file.type)}`);
      return;
    }
    for (const entry of await dir.entries()) {
      const size = entry.kind === "file" ? String(entry.size).padStart(12) : "".padStart(12);
      const name = entry.kind === "directory" ? chalk.bold(`${entry.name}/`) : entry.name;
      console.log(`${size}  ${name}`);
    }
  });

program
  .command("cat")
  .description("write a file to stdout, including one inside an archive")
  .argument("<source>", "a directory, or an http(s) URL")
  .argument("<path>", "path within the tree; may use archive.zip#/inner")
  .option("-i, --case-insensitive", "match names without regard to case", false)
  .action(async (source, path, opts) => {
    const fs = await open(source, { caseInsensitive: opts.caseInsensitive });
    const file = await fs.file(path);
    if (!file) {
      console.error(chalk.red(`${path}: not found`));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(await file.bytes());
  });

await program.parseAsync();
