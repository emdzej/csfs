import { defineConfig, devices } from "@playwright/test";

/**
 * Every engine, because the backends meet a different browser API in each:
 * OPFS writes arrived in WebKit late, `DecompressionStream` and
 * `ReadableStream` cancellation differ in the details, and "Illegal
 * invocation" is a Chromium message for a mistake every engine punishes.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./src/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
