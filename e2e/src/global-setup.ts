/**
 * Build the fixture and the harness, start the hosts, and tell the tests where.
 *
 * Environment variables set here reach every worker, which is how a test
 * learns its origins; the ports are the OS's choice, so two runs never collide.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { buildFixture } from "./fixture.js";
import { serve } from "./server.js";

const here = fileURLToPath(new URL(".", import.meta.url));

export default async function globalSetup(): Promise<() => Promise<void>> {
  const tree = await buildFixture();
  const harness = await mkdtemp(join(tmpdir(), "csfs-e2e-harness-"));
  await build({
    root: join(here, "..", "harness"),
    logLevel: "warn",
    build: { outDir: harness, emptyOutDir: true },
  });
  const demo = join(here, "..", "..", "apps", "demo", "dist");
  const servers = await serve(tree, harness, demo);
  process.env.CSFS_ORIGIN = servers.origin;
  process.env.CSFS_CROSS_ORIGIN = servers.crossOrigin;
  process.env.CSFS_DEMO_ORIGIN = servers.demoOrigin;
  return async () => {
    await servers.close();
    await rm(tree, { recursive: true, force: true });
    await rm(harness, { recursive: true, force: true });
  };
}
