/**
 * A file system over the origin private file system.
 *
 * OPFS is the same API as a picked directory, reached through
 * `navigator.storage.getDirectory()` instead of a prompt — so this reuses the
 * FSA backend rather than reimplementing it, and adds only what differs.
 *
 * What differs is worth knowing:
 *
 * - **No permission prompt, ever.** The origin owns this storage, so a
 *   remembered tree reopens silently. That is the reason to import into OPFS
 *   rather than to keep a directory handle: a picked directory loses its
 *   permission on reload, this does not.
 * - **It is evictable.** A browser may clear it under storage pressure unless
 *   `navigator.storage.persist()` has been granted, which is why `persist()`
 *   is offered here and why a consumer should call it before writing gigabytes.
 * - **`createSyncAccessHandle` writes in place**, so OPFS avoids the doubled
 *   write traffic `createWritable` costs — but only inside a worker.
 */
import { FsaFileSystem, type FsaFileSystemOptions } from "@emdzej/csfs-fsa";

/** Is OPFS available? */
export function isOpfsSupported(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function"
  );
}

export interface OpfsFileSystemOptions extends FsaFileSystemOptions {
  /**
   * A subdirectory to root at, created if absent.
   *
   * Recommended: OPFS is shared by everything on the origin, so a consumer
   * that roots at `/` will see — and can delete — another one's files.
   */
  namespace?: string;
}

/** Open OPFS, optionally rooted at a namespace. */
export async function opfsFileSystem(opts: OpfsFileSystemOptions = {}): Promise<FsaFileSystem> {
  if (!isOpfsSupported()) throw new Error("this browser has no origin private file system");
  let root = await navigator.storage.getDirectory();
  if (opts.namespace) {
    root = await root.getDirectoryHandle(opts.namespace, { create: true });
  }
  const { caseInsensitive } = opts;
  return new FsaFileSystem(root, caseInsensitive === undefined ? {} : { caseInsensitive });
}

/**
 * Ask for storage that will not be evicted.
 *
 * Worth doing before writing anything large. The browser decides, and may say
 * no without explanation, so the answer is returned rather than thrown — a
 * consumer can still proceed, it just cannot promise the data will survive.
 */
export async function persist(): Promise<boolean> {
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** How much room there is, as the browser sees it. Both may be undefined. */
export async function quota(): Promise<{ usage?: number; quota?: number }> {
  try {
    const estimate = await navigator.storage.estimate();
    return {
      ...(estimate.usage !== undefined ? { usage: estimate.usage } : {}),
      ...(estimate.quota !== undefined ? { quota: estimate.quota } : {}),
    };
  } catch {
    return {};
  }
}

/** Delete everything in a namespace. */
export async function clearNamespace(namespace: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await (
    root as FileSystemDirectoryHandle & {
      removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
    }
  ).removeEntry(namespace, { recursive: true });
}

export { FsaFileSystem as OpfsFileSystem };
