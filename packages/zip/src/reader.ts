/**
 * A `zip.js` reader over a `CsFile`.
 *
 * This is the whole trick behind mounting archives: `zip.js` reads through a
 * `Reader` interface, and a `CsFile` already offers `size` and `slice`. So one
 * small adapter lets an archive be read from *any* backend — over HTTP by
 * range, out of a picked directory, out of OPFS, or out of another archive —
 * without csfs implementing a single byte of the zip format.
 *
 * Zip handling is not reinvented here on purpose. The format has enough
 * corners to be worth a library: zip64 for anything over 4 GB or 65,535
 * entries, the data-descriptor case where sizes trail the data, cp437 versus
 * UTF-8 entry names, and — the one that catches people — archives whose
 * *local* headers carry zero sizes and a zero CRC while the central directory
 * holds the truth. `zip.js` reads the central directory, which is what makes
 * those readable at all.
 */
import { Reader } from "@zip.js/zip.js";
import type { CsFile } from "@emdzej/csfs-core";

/**
 * Presents a `CsFile` to `zip.js`.
 *
 * `readUint8Array` is the only method that touches data, and it slices rather
 * than buffering, so reading a central directory out of a 945 MB archive costs
 * two range reads instead of a download.
 */
export class CsFileReader extends Reader<CsFile> {
  // Kept alongside rather than read back from the base class: `Reader.value`
  // is not part of zip.js's published types, and relying on an internal would
  // make a patch release able to break this.
  private readonly file: CsFile;

  constructor(file: CsFile) {
    super(file);
    this.file = file;
    this.size = file.size;
  }

  override async init(): Promise<void> {
    this.size = this.file.size;
  }

  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    const bytes = await this.file.slice(index, index + length).bytes();
    // A short read means the backend clamped a range. Saying so beats handing
    // back a truncated buffer that a parser will misread as corrupt data.
    if (bytes.byteLength < length) {
      throw new Error(
        `${this.file.path}: wanted ${length} bytes at ${index}, got ${bytes.byteLength}`,
      );
    }
    return bytes;
  }
}
