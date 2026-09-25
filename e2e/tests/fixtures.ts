import { test as base, type Page } from "@playwright/test";

export { expect } from "@playwright/test";

/** The origins global setup started. Read per test, after setup has run. */
export const origins = () => ({
  origin: process.env.CSFS_ORIGIN!,
  cross: process.env.CSFS_CROSS_ORIGIN!,
  demo: process.env.CSFS_DEMO_ORIGIN!,
});

/** A page with the libraries loaded on `window.csfs`. */
export const test = base.extend<{ harness: Page }>({
  harness: async ({ page }, use) => {
    await page.goto(origins().origin);
    await page.waitForSelector("body[data-ready='1']");
    await use(page);
  },
});

/**
 * A harness page for storage tests: a persistent profile on WebKit only.
 *
 * WebKit gives an ephemeral context no OPFS: `getDirectory` rejects with
 * `UnknownError`, exactly as Safari's private browsing does. A profile on disk
 * is what a real visitor has, so WebKit gets one — a fresh directory per test,
 * so each still starts from an empty origin. Chromium and Firefox have OPFS in
 * an ordinary context, and keep one: closing a persistent Chromium profile
 * occasionally took longer than the whole test timeout.
 */
export const storage = base.extend<{ harness: Page }>({
  harness: async ({ page, playwright, browserName }, use) => {
    if (browserName !== "webkit") {
      await page.goto(origins().origin);
      await page.waitForSelector("body[data-ready='1']");
      await use(page);
      return;
    }
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const profile = await mkdtemp(join(tmpdir(), "csfs-e2e-webkit-"));
    const context = await playwright.webkit.launchPersistentContext(profile);
    try {
      const own = context.pages()[0] ?? (await context.newPage());
      await own.goto(origins().origin);
      await own.waitForSelector("body[data-ready='1']");
      await use(own);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
});
