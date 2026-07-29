<script lang="ts">
  import type { DirectoryListing } from "@pty-server/protocol";
  import { useServerRegistry } from "../../registry/context";

  interface Props {
    open: boolean;
    onCreate: (path: string, serverId: string) => void | Promise<void>;
    onBrowse: (serverId: string, path: string | undefined, q: string | undefined, cursor: string | undefined) => Promise<DirectoryListing>;
    onClose: () => void;
    error?: string;
  }

  let { open, onCreate, onBrowse, onClose, error }: Props = $props();
  const registry = useServerRegistry();

  let selectedServerId = $state<string>("");
  let listing = $state<DirectoryListing | undefined>(undefined);
  let filter = $state("");
  let loading = $state(false);
  let browseError = $state("");
  let loadedServerId = $state("");
  let requestNumber = 0;
  let filterTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (open && !selectedServerId && registry.defaultServerId) {
      selectedServerId = registry.defaultServerId;
    }
  });

  $effect(() => {
    if (!open) {
      loadedServerId = "";
      listing = undefined;
      filter = "";
      browseError = "";
      if (filterTimer) clearTimeout(filterTimer);
      return;
    }
    if (selectedServerId && selectedServerId !== loadedServerId) {
      loadedServerId = selectedServerId;
      resetAndBrowse();
    }
  });

  async function browse(
    path: string | undefined = undefined,
    q: string | undefined = undefined,
    cursor: string | undefined = undefined,
    append = false,
  ) {
    if (!selectedServerId) return;
    const request = ++requestNumber;
    loading = true;
    browseError = "";
    try {
      const next = await onBrowse(selectedServerId, path, q, cursor);
      if (request !== requestNumber) return;
      listing = append && listing
        ? { ...next, entries: [...listing.entries, ...next.entries] }
        : next;
    } catch (err) {
      if (request === requestNumber) browseError = err instanceof Error ? err.message : String(err);
    } finally {
      if (request === requestNumber) loading = false;
    }
  }

  function resetAndBrowse(path: string | undefined = undefined) {
    if (filterTimer) clearTimeout(filterTimer);
    filter = "";
    listing = undefined;
    void browse(path);
  }

  function changeServer() {
    loadedServerId = selectedServerId;
    resetAndBrowse();
  }

  function changeFilter(event: Event) {
    filter = (event.currentTarget as HTMLInputElement).value;
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      if (listing?.current) void browse(listing.current.path, filter);
    }, 250);
  }

  function navigate(path: string) {
    resetAndBrowse(path);
  }

  function parentPath(): string | undefined {
    return listing?.breadcrumbs[listing.breadcrumbs.length - 2]?.path;
  }

  function handleCreate() {
    if (!listing?.current || !selectedServerId) return;
    onCreate(listing.current.path, selectedServerId);
  }

  function handleCancel() {
    requestNumber++;
    onClose();
  }
</script>

{#if open}
  <div class="overlay" role="presentation" onclick={handleCancel} onkeydown={(e) => e.key === "Escape" && handleCancel()}>
    <div class="dialog" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && handleCancel()}>
      <h2>Add Workspace</h2>

      {#if registry.servers.length > 1}
        <label>
          Server
          <select bind:value={selectedServerId} onchange={changeServer}>
            <option value="" disabled>-- select --</option>
            {#each registry.servers as conn (conn.config.id)}
              <option value={conn.config.id}>{conn.config.label}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if listing?.current}
        <div class="breadcrumbs" aria-label="Current directory">
          <button type="button" onclick={() => resetAndBrowse()}>Roots</button>
          <button type="button" disabled={!parentPath()} onclick={() => { const path = parentPath(); if (path) navigate(path); }}>Parent</button>
          {#each listing.breadcrumbs as crumb, index (crumb.path)}
            <span>/</span>
            <button type="button" onclick={() => navigate(crumb.path)}>{crumb.name}</button>
            {#if index === listing.breadcrumbs.length - 1}<span class="current-name">(current)</span>{/if}
          {/each}
        </div>
        <label>
          Filter directory names
          <input type="search" value={filter} oninput={changeFilter} placeholder="Filter names" />
        </label>
      {:else}
        <p class="hint">Choose a directory root.</p>
      {/if}

      <div class="directory-list" aria-label="Directories">
        {#if loading && !listing}<p class="hint">Loading directories…</p>{/if}
        {#each listing?.entries ?? [] as entry (entry.name + entry.path)}
          <button type="button" class="directory" onclick={() => navigate(entry.path)}>{entry.name}</button>
        {:else}
          {#if listing && !loading}<p class="hint">No directories found.</p>{/if}
        {/each}
      </div>

      {#if listing?.nextCursor}
        <button type="button" class="more" disabled={loading} onclick={() => listing && browse(listing.current?.path, filter, listing.nextCursor, true)}>
          {loading ? "Loading…" : "Load more"}
        </button>
      {/if}

      {#if browseError}<p class="error" role="alert">{browseError}</p>{/if}

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <div class="actions">
        <button type="button" class="cancel" onclick={handleCancel}>Cancel</button>
        <button type="button" class="create" disabled={!listing?.current || !selectedServerId || loading} onclick={handleCreate}>Use this directory</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: var(--sp-4);
    min-width: 320px;
    max-width: 90vw;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  h2 {
    margin: 0;
    font-size: 1rem;
    color: var(--fg);
  }

  label {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    font-size: 0.85rem;
    color: var(--fg-dim);
  }

  select,
  input {
    padding: var(--sp-1) var(--sp-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    font-size: 0.85rem;
  }

  select:focus,
  input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .error {
    margin: 0;
    color: #e05252;
    font-size: 0.85rem;
  }

  .hint {
    color: var(--fg-dim);
    font-size: 0.85rem;
    margin: 0;
  }

  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-1);
    color: var(--fg-dim);
    font-size: 0.8rem;
  }

  .breadcrumbs button,
  .directory,
  .more {
    background: var(--bg);
    color: var(--fg);
  }

  .current-name { color: var(--fg-dim); }

  .directory-list {
    display: flex;
    flex-direction: column;
    min-height: 8rem;
    max-height: 18rem;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 3px;
  }

  .directory {
    border: 0;
    border-radius: 0;
    text-align: left;
  }

  .actions {
    display: flex;
    gap: var(--sp-2);
    justify-content: flex-end;
    margin-top: var(--sp-2);
  }

  button {
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .cancel {
    background: var(--bg);
    color: var(--fg-dim);
  }

  .create {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .create:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
