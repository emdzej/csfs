import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  /*
   * A custom domain serves at the root; `<user>.github.io/<repo>/` serves under
   * a prefix. `base` is baked into the built HTML and a build cannot be
   * relocated afterwards, so the deploy decides it and a wrong one fails
   * quietly: `index.html` still returns 200 and every asset 404s.
   */
  base: process.env.BASE_PATH ?? "/",
  plugins: [svelte()],
});
