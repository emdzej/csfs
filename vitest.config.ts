import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Each package's sources, not its `dist`. Through `main`, a bare
    // `pnpm test` after an edit ran the new tests against the old build of
    // every *other* package, and passed or failed for reasons nobody had
    // written yet.
    alias: [
      {
        find: /^@emdzej\/csfs-(core|zip|http|fsa|opfs|node|manifest)$/,
        replacement: fileURLToPath(new URL("./packages/$1/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    // The parity suite stands up a server and builds archives before it runs.
    hookTimeout: 60_000,
  },
});
