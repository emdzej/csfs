/**
 * The libraries, as a page sees them.
 *
 * Bundled by Vite from the packages' built `dist`, the same way a consumer's
 * bundler would take them, and hung on `window` so a test can reach them from
 * `page.evaluate`. Nothing here is logic: a test that needs a helper writes it
 * where the reader can see it.
 */
import * as core from "@emdzej/csfs-core";
import * as fsa from "@emdzej/csfs-fsa";
import * as http from "@emdzej/csfs-http";
import * as manifest from "@emdzej/csfs-manifest";
import * as opfs from "@emdzej/csfs-opfs";
import * as zip from "@emdzej/csfs-zip";

const csfs = { core, fsa, http, manifest, opfs, zip };

declare global {
  interface Window {
    csfs: typeof csfs;
  }
}

window.csfs = csfs;
document.body.dataset.ready = "1";
