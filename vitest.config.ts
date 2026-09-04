import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    // The browser-backed suites launch Chromium and read a real tree, which
    // the 5 s default cannot cover.
    testTimeout: process.env.CSFS_E2E_URL ? 120_000 : 5_000,
    hookTimeout: 60_000,
  },
});
