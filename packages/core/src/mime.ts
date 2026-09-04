/**
 * MIME type by extension.
 *
 * Small and deliberate rather than a dependency: what a filesystem needs this
 * for is handing a blob URL to an `<img>` or an `<iframe>`, and those care
 * about a handful of types. An `<img>` will sniff a typeless blob and cope; an
 * `<iframe>` handed a typeless PDF offers a download instead of rendering it,
 * which is the failure this exists to prevent.
 */
const TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

import { extname } from "./path.js";

/** The type for a path, or `"application/octet-stream"` when unknown. */
export function mimeType(path: string): string {
  return TYPES[extname(path)] ?? "application/octet-stream";
}

/** Register or override a type. For consumers with their own conventions. */
export function registerMimeType(extension: string, type: string): void {
  (TYPES as Record<string, string>)[extension.toLowerCase()] = type;
}
