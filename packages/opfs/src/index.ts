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
 * - **`createSyncAccessHandle` could write in place**, avoiding the doubled
 *   write traffic `createWritable` costs — but only inside a worker, and this
 *   backend does not use it. Writes here stage and swap, as on a picked
 *   directory.
 */
import { untilAborted } from "@emdzej/csfs-core";
import { FsaFileSystem, type FsaFileSystemOptions } from "@emdzej/csfs-fsa";

type Removable = FileSystemDirectoryHandle & {
  removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
};

/**
 * The FSA backend over OPFS, reporting itself as such.
 *
 * A subclass only for `kind`: it was `"fsa"`, although `"opfs"` is one of the
 * kinds the interface names, so a wrapped one read `fsa+zip` in diagnostics.
 */
export class OpfsFileSystem extends FsaFileSystem {
  override readonly kind: string = "opfs";
}

/** A namespace's segments. `"a/b"` nests, rather than reaching the API as a name. */
function namespaceParts(namespace: string): string[] {
  const parts = namespace.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new Error(`namespace ${namespace} may not contain ..`);
  return parts;
}

/**
 * Is OPFS available?
 *
 * Whether the API exists, not whether it works: Safari in a private window
 * has `getDirectory` and rejects it with `UnknownError`, so `opfsFileSystem`
 * can still fail where this said yes.
 */
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
export async function opfsFileSystem(
  opts: OpfsFileSystemOptions = {},
): Promise<OpfsFileSystem> {
  if (!isOpfsSupported()) throw new Error("this browser has no origin private file system");
  let root = await navigator.storage.getDirectory();
  for (const part of namespaceParts(opts.namespace ?? "")) {
    root = await root.getDirectoryHandle(part, { create: true });
  }
  const { caseInsensitive } = opts;
  return new OpfsFileSystem(root, caseInsensitive === undefined ? {} : { caseInsensitive });
}

/**
 * Ask for storage that will not be evicted.
 *
 * Worth doing before writing anything large. The browser decides, and may say
 * no without explanation, so the answer is returned rather than thrown — a
 * consumer can still proceed, it just cannot promise the data will survive.
 *
 * **It may never answer.** Firefox shows the user a prompt, and the promise
 * waits on them; with nobody there — or a user who ignores it — it does not
 * settle. Pass a signal (`AbortSignal.timeout(5000)`) and an abort counts as
 * no. Found by the e2e suite, where headless Firefox left it pending forever.
 */
export async function persist(opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  try {
    if (await navigator.storage.persisted()) return true;
    return await untilAborted(navigator.storage.persist(), opts.signal);
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

/**
 * Delete everything in a namespace. Succeeds if there is nothing to delete.
 *
 * Refuses an empty namespace: that is the whole origin's storage, and every
 * other consumer's files with it.
 */
export async function clearNamespace(namespace: string): Promise<void> {
  const parts = namespaceParts(namespace);
  const last = parts.pop();
  if (last === undefined)
    throw new Error("refusing to clear the whole origin: name a namespace");
  try {
    let parent = await navigator.storage.getDirectory();
    for (const part of parts) parent = await parent.getDirectoryHandle(part);
    await (parent as Removable).removeEntry(last, { recursive: true });
  } catch (e) {
    if ((e as { name?: unknown } | null)?.name !== "NotFoundError") throw e;
  }
}
