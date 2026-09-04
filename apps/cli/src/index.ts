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
import { writeFile } from "node:fs/promises";
import { Command } from "@commander-js/extra-typings";
import chalk from "chalk";
import { walkFileSystem, type CsFileSystem } from "@emdzej/csfs-core";
import { httpFileSystem } from "@emdzej/csfs-http";
import { buildManifest, formatManifest, MANIFEST_FILE } from "@emdzej/csfs-manifest";
import { nodeFileSystem } from "@emdzej/csfs-node";
import { withArchives } from "@emdzej/csfs-zip";

/** A URL means HTTP; anything else is a directory. */
function open(source: string): CsFileSystem {
  const remote = source.startsWith("http://") || source.startsWith("https://");
  return withArchives(remote ? httpFileSystem(source) : nodeFileSystem(source));
}

const program = new Command("csfs")
  .description("Client-side file system tooling")
  .version("0.1.0");

program
  .command("manifest")
  .description("describe a directory so it can be served over static HTTP")
  .argument("<dir>", "directory to describe")
  .option("-o, --out <file>", `where to write it (default: <dir>/${MANIFEST_FILE})`)
  .option("-l, --label <text>", "a name for this tree")
  .option("--pretty", "indent the JSON — larger, but readable in a diff", false)
  .option(
    "--archive <spec...>",
    "an archive to read in place: <archive>:<serves>[:basename]. " +
      "Repeatable. Without this an archive is just a file.",
  )
  .option("-n, --dry-run", "print the summary and stop", false)
  .action(async (dir, opts) => {
    const fs = nodeFileSystem(dir);
    if (!(await fs.directory("/"))) {
      console.error(chalk.red(`${dir}: not a directory`));
      process.exitCode = 1;
      return;
    }

    const archives = (opts.archive ?? []).map((spec) => {
      const [archive, serves, entry] = spec.split(":");
      if (!archive || !serves) {
        throw new Error(`--archive ${spec}: expected <archive>:<serves>[:basename]`);
      }
      return {
        archive,
        serves,
        ...(entry === "basename" ? { entry: "basename" as const } : {}),
      };
    });

    let last = Date.now();
    const manifest = await buildManifest(fs, {
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      builtAt: new Date().toISOString(),
      ...(archives.length > 0 ? { archives } : {}),
      // A manifest that describes itself carries a size that is wrong the
      // moment it is written, which is worse than its absence.
      filter: (path) => !path.endsWith(`/${MANIFEST_FILE}`),
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
    if (opts.dryRun) {
      console.log(chalk.dim("--dry-run: nothing written."));
      return;
    }
    const out = opts.out ?? `${dir.replace(/\/+$/, "")}/${MANIFEST_FILE}`;
    await writeFile(out, text);
    console.log(`written to ${chalk.bold(out)}`);
    console.log(
      chalk.dim("\nServe the directory with Range support and point a client at its URL."),
    );
  });

program
  .command("ls")
  .description("list a path through any backend")
  .argument("<source>", "a directory, or an http(s) URL")
  .argument("[path]", "path within the tree", "/")
  .option("-R, --recursive", "walk the whole subtree", false)
  .action(async (source, path, opts) => {
    const fs = open(source);
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
  .action(async (source, path) => {
    const file = await open(source).file(path);
    if (!file) {
      console.error(chalk.red(`${path}: not found`));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(await file.bytes());
  });

await program.parseAsync();
