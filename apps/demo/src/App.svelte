<script lang="ts">
  /**
   * csfs, demonstrated.
   *
   * Four sources, one browser: an HTTP tree, a folder, a zip archive, and
   * OPFS. The point of the page is that everything below the source picker is
   * written once — the tree view neither knows nor can tell which backend it
   * is reading, which is the claim the library makes.
   *
   * It also builds a manifest from a picked folder, so a tree can be prepared
   * for static hosting without installing anything.
   */
  import {
    walkFileSystem,
    type CsDirectory,
    type CsEntry,
    type CsFile,
    type CsFileSystem,
    objectUrl,
    toBlob,
  } from "@emdzej/csfs-core";
  import { isFsaSupported, pickArchive, pickDirectory, fsaFileSystem } from "@emdzej/csfs-fsa";
  import { httpFileSystem } from "@emdzej/csfs-http";
  import { buildManifest, formatManifest } from "@emdzej/csfs-manifest";
  import { isOpfsSupported, opfsFileSystem, quota } from "@emdzej/csfs-opfs";
  import { withArchives, withTransparentArchives, zipFromBlob } from "@emdzej/csfs-zip";

  let fs = $state<CsFileSystem | undefined>(undefined);
  let label = $state("");
  let path = $state("/");
  let entries = $state<CsEntry[]>([]);
  let error = $state<string | undefined>(undefined);
  let busy = $state<string | undefined>(undefined);
  let preview = $state<{ file: CsFile; text?: string; url?: string } | undefined>(undefined);
  let url = $state("");
  let manifestText = $state<string | undefined>(undefined);
  let stats = $state<string | undefined>(undefined);

  const supported = { fsa: isFsaSupported(), opfs: isOpfsSupported() };

  async function open(next: CsFileSystem, name: string): Promise<void> {
    error = undefined;
    preview = undefined;
    manifestText = undefined;
    fs = next;
    label = name;
    await go("/");
  }

  async function go(to: string): Promise<void> {
    if (!fs) return;
    error = undefined;
    preview = undefined;
    try {
      const dir = await fs.directory(to);
      if (!dir) {
        // A path can be a file, which is worth saying rather than reporting
        // "not found" for something that plainly exists.
        const file = await fs.file(to);
        if (file) return void show(file);
        error = `${to}: not found`;
        return;
      }
      path = to;
      entries = sort(await dir.entries());
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Directories first, then by name — the order a listing is read in. */
  function sort(list: CsEntry[]): CsEntry[] {
    return [...list].sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
    );
  }

  const TEXTUAL = /^(text\/|application\/(json|xml|javascript))/;

  async function show(file: CsFile): Promise<void> {
    // Only the first 64 KB, and only for text. A 300 MB file rendered into the
    // DOM would hang the tab, and the point here is to prove the read worked.
    if (TEXTUAL.test(file.type)) {
      preview = { file, text: await file.slice(0, 65_536).text() };
      return;
    }
    if (file.type.startsWith("image/") || file.type === "application/pdf") {
      // Revoked when the preview closes or is replaced; a page that mints one
      // per image and never revokes pins every image it has ever shown.
      if (preview?.url) URL.revokeObjectURL(preview.url);
      preview = { file, url: await objectUrl(file) };
      return;
    }
    preview = { file };
  }

  async function openEntry(entry: CsEntry): Promise<void> {
    const next = `${path === "/" ? "" : path}/${entry.name}`;
    if (entry.kind === "directory") return void go(next);
    if (!fs) return;
    const file = await fs.file(next);
    if (!file) {
      error = `${next}: could not be read`;
      return;
    }
    // A zip inside the tree can be stepped into, which is what `#` is for.
    if (entry.name.toLowerCase().endsWith(".zip")) {
      await open(withArchives(zipFromBlob(await asBlob(file), { path: next })), `${label} ▸ ${entry.name}`);
      return;
    }
    await show(file);
  }

  /** A `CsFile` is not a `Blob`; make one from its bytes. */
  async function asBlob(file: CsFile): Promise<File> {
    return new File([toBlob(await file.bytes(), file.type)], file.name, { type: file.type });
  }

  const parent = $derived(
    path === "/" ? undefined : path.slice(0, path.lastIndexOf("/")) || "/",
  );

  async function openHttp(): Promise<void> {
    if (!url.trim()) return;
    busy = "reading the manifest";
    try {
      const base = httpFileSystem(url.trim());
      // A tree may declare archives it keeps packed; honour them.
      const archives = await base.archives().catch(() => []);
      await open(
        archives.length > 0 ? withTransparentArchives(withArchives(base), archives) : withArchives(base),
        url.trim(),
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = undefined;
    }
  }

  async function openFolder(): Promise<void> {
    try {
      const handle = await pickDirectory("read");
      await open(withArchives(fsaFileSystem(handle)), handle.name);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function openZip(): Promise<void> {
    try {
      const file = await pickArchive();
      await open(withArchives(zipFromBlob(file)), file.name);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** `<input type="file">`, which works in every browser unlike the pickers. */
  async function openZipInput(event: Event): Promise<void> {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    await open(withArchives(zipFromBlob(file)), file.name);
  }

  async function openOpfs(): Promise<void> {
    try {
      const opfs = await opfsFileSystem({ namespace: "csfs-demo" });
      const { usage, quota: limit } = await quota();
      stats =
        usage !== undefined
          ? `${(usage / 1e6).toFixed(1)} MB used of ${limit ? `${(limit / 1e9).toFixed(1)} GB` : "an unknown quota"}`
          : undefined;
      await open(withArchives(opfs), "origin private file system");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Copy the open tree into OPFS, so it survives a reload with no prompt. */
  async function copyToOpfs(): Promise<void> {
    if (!fs) return;
    busy = "copying into OPFS";
    try {
      const target = await opfsFileSystem({ namespace: "csfs-demo" });
      let n = 0;
      for await (const entry of walkFileSystem(fs, "/")) {
        const file = await fs.file(entry.path);
        if (!file) continue;
        await target.write(entry.path, await file.bytes());
        n += 1;
        busy = `copying into OPFS — ${n} files`;
      }
      busy = undefined;
      stats = `${n} files copied into OPFS`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = undefined;
    }
  }

  async function makeManifest(): Promise<void> {
    if (!fs) return;
    busy = "walking the tree";
    try {
      const manifest = await buildManifest(fs, {
        label,
        builtAt: new Date().toISOString(),
        onProgress: (found) => {
          busy = `walking the tree — ${found.toLocaleString()} files`;
        },
      });
      manifestText = formatManifest(manifest, { pretty: true });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = undefined;
    }
  }

  function downloadManifest(): void {
    if (!manifestText) return;
    const blob = new Blob([manifestText], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "csfs-manifest.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const bytes = (n: number) =>
    n < 1024
      ? `${n} B`
      : n < 1e6
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1e6).toFixed(1)} MB`;
</script>

<main>
  <header>
    <h1>csfs</h1>
    <p>
      One read API over static HTTP, a folder, a zip archive, and the origin private file system —
      including <em>inside</em> archives, by byte range.
    </p>
  </header>

  <section class="sources">
    <div class="row">
      <input
        bind:value={url}
        placeholder="https://host/tree — needs a csfs-manifest.json and Range support"
        aria-label="HTTP tree URL"
        onkeydown={(e) => e.key === "Enter" && openHttp()}
      />
      <button class="primary" onclick={openHttp} disabled={!url.trim()}>Open URL</button>
    </div>
    <div class="row">
      <button onclick={openFolder} disabled={!supported.fsa}>Open folder…</button>
      <button onclick={openZip} disabled={!supported.fsa}>Open .zip…</button>
      <label class="filebtn">
        Open .zip (any browser)
        <input type="file" accept=".zip,application/zip" onchange={openZipInput} />
      </label>
      <button onclick={openOpfs} disabled={!supported.opfs}>Open OPFS</button>
    </div>
    {#if !supported.fsa}
      <p class="note">
        The folder and archive pickers need the File System Access API, which is Chromium-only.
        The <code>&lt;input type="file"&gt;</code> route works everywhere — a picked
        <code>File</code> is a <code>Blob</code>, which is all csfs asks for.
      </p>
    {/if}
  </section>

  {#if error}<p class="error">{error}</p>{/if}
  {#if busy}<p class="busy">{busy}…</p>{/if}
  {#if stats}<p class="note">{stats}</p>{/if}

  {#if fs}
    <section class="tree">
      <div class="crumbs">
        <span class="backend">{fs.kind}</span>
        <strong>{label}</strong>
        <code>{path}</code>
        <span class="spacer"></span>
        <button onclick={makeManifest}>Build manifest</button>
        {#if supported.opfs}<button onclick={copyToOpfs}>Copy to OPFS</button>{/if}
      </div>

      <ul>
        {#if parent !== undefined}
          <li><button onclick={() => go(parent)}>..</button></li>
        {/if}
        {#each entries as entry (entry.name)}
          <li>
            <button onclick={() => openEntry(entry)}>
              <span class="name" class:dir={entry.kind === "directory"}>
                {entry.name}{entry.kind === "directory" ? "/" : ""}
              </span>
              {#if entry.kind === "file"}
                <span class="size">{entry.size > 0 ? bytes(entry.size) : ""}</span>
              {/if}
            </button>
          </li>
        {/each}
        {#if entries.length === 0}
          <li class="empty">empty</li>
        {/if}
      </ul>
    </section>

    {#if preview}
      <section class="preview">
        <div class="crumbs">
          <code>{preview.file.path}</code>
          <span class="size">{bytes(preview.file.size)}</span>
          <span class="note">{preview.file.type || "unknown type"}</span>
          <span class="spacer"></span>
          <button onclick={() => (preview = undefined)}>close</button>
        </div>
        {#if preview.text !== undefined}
          <pre>{preview.text}</pre>
          {#if preview.file.size > 65_536}
            <p class="note">First 64 KB shown — the read is by range, so the rest was not fetched.</p>
          {/if}
        {:else if preview.url}
          {#if preview.file.type === "application/pdf"}
            <iframe title={preview.file.name} src={preview.url}></iframe>
          {:else}
            <img alt={preview.file.name} src={preview.url} />
          {/if}
        {:else}
          <p class="note">No preview for this type. It read {bytes(preview.file.size)} correctly.</p>
        {/if}
      </section>
    {/if}

    {#if manifestText}
      <section class="preview">
        <div class="crumbs">
          <strong>csfs-manifest.json</strong>
          <span class="size">{bytes(manifestText.length)}</span>
          <span class="spacer"></span>
          <button class="primary" onclick={downloadManifest}>Download</button>
          <button onclick={() => (manifestText = undefined)}>close</button>
        </div>
        <pre>{manifestText.slice(0, 20_000)}</pre>
      </section>
    {/if}
  {/if}

  <footer>
    <a href="https://github.com/emdzej/csfs">Source</a>
    <a href="https://github.com/emdzej/csfs/blob/main/LICENSE">MIT</a>
  </footer>
</main>
