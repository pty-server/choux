<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { DirectoryEntry, DirectoryListing } from "@pty-server/protocol";

  interface Props {
    browse: (path: string | undefined, q: string | undefined, cursor: string | undefined) => Promise<DirectoryListing>;
    scoped?: boolean;
    onCurrentChange?: (current: DirectoryEntry | undefined) => void;
    onLoadingChange?: (loading: boolean) => void;
  }

  let { browse, scoped = false, onCurrentChange, onLoadingChange }: Props = $props();

  let listing = $state<DirectoryListing | undefined>(undefined);
  let loading = $state(false);
  let filter = $state("");
  let browseError = $state("");
  let requestNumber = 0;
  let filterTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    resetAndBrowse();
  });

  onDestroy(() => {
    requestNumber++;
    if (filterTimer) clearTimeout(filterTimer);
  });

  function setLoading(next: boolean) {
    loading = next;
    onLoadingChange?.(next);
  }

  function setListing(next: DirectoryListing | undefined) {
    listing = next;
    onCurrentChange?.(next?.current);
  }

  async function load(
    path: string | undefined = undefined,
    q: string | undefined = undefined,
    cursor: string | undefined = undefined,
    append = false,
  ) {
    const request = ++requestNumber;
    setLoading(true);
    browseError = "";
    try {
      const next = await browse(path, q, cursor);
      if (request !== requestNumber) return;
      setListing(append && listing ? { ...next, entries: [...listing.entries, ...next.entries] } : next);
    } catch (err) {
      if (request === requestNumber) browseError = err instanceof Error ? err.message : String(err);
    } finally {
      if (request === requestNumber) setLoading(false);
    }
  }

  function resetAndBrowse(path: string | undefined = undefined) {
    if (filterTimer) clearTimeout(filterTimer);
    filter = "";
    setListing(undefined);
    void load(path);
  }

  function changeFilter(event: Event) {
    filter = (event.currentTarget as HTMLInputElement).value;
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      if (listing?.current) void load(listing.current.path, filter);
    }, 250);
  }

  function parentPath(): string | undefined {
    return listing?.breadcrumbs[listing.breadcrumbs.length - 2]?.path;
  }
</script>

{#if listing?.current}
  <div class="breadcrumbs" aria-label="Current directory">
    {#if !scoped}<button type="button" onclick={() => resetAndBrowse()}>Roots</button>{/if}
    <button type="button" disabled={!parentPath()} onclick={() => { const path = parentPath(); if (path) resetAndBrowse(path); }}>Parent</button>
    {#each listing.breadcrumbs as crumb, index (crumb.path)}
      <span>/</span>
      <button type="button" onclick={() => resetAndBrowse(crumb.path)}>{crumb.name}</button>
      {#if index === listing.breadcrumbs.length - 1}<span class="current-name">(current)</span>{/if}
    {/each}
  </div>
  <label>
    Filter directory names
    <input type="search" value={filter} oninput={changeFilter} placeholder="Filter names" />
  </label>
{:else if !scoped}
  <p class="hint">Choose a directory root.</p>
{/if}

<div class="directory-list" aria-label="Directories">
  {#if loading && !listing}<p class="hint">Loading directories…</p>{/if}
  {#each listing?.entries ?? [] as entry (entry.name + entry.path)}
    <button type="button" class="directory" onclick={() => resetAndBrowse(entry.path)}>{entry.name}</button>
  {:else}
    {#if listing && !loading}<p class="hint">No directories found.</p>{/if}
  {/each}
</div>

{#if listing?.nextCursor}
  <button type="button" class="more" disabled={loading} onclick={() => listing && load(listing.current?.path, filter, listing.nextCursor, true)}>
    {loading ? "Loading…" : "Load more"}
  </button>
{/if}

{#if browseError}<p class="error" role="alert">{browseError}</p>{/if}

<style>
  label {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    font-size: 0.85rem;
    color: var(--fg-dim);
  }

  input {
    padding: var(--sp-1) var(--sp-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    font-size: 0.85rem;
  }

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

  button {
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85rem;
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
</style>
