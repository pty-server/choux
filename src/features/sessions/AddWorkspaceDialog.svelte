<script lang="ts">
  import { defaultWorkspaceName, type DirectoryEntry, type DirectoryListing, type WorkspaceKind } from "@pty-server/protocol";
  import { useServerRegistry } from "../../registry/context";
  import { incompatibleServerMessage, runnerSupport } from "../../registry/protocolSupport";
  import DirectoryBrowser from "./DirectoryBrowser.svelte";

  interface Props {
    open: boolean;
    onCreate: (workspace: { path: string; kind: WorkspaceKind; name?: string }, serverId: string) => void | Promise<void>;
    onBrowse: (serverId: string, path: string | undefined, q: string | undefined, cursor: string | undefined) => Promise<DirectoryListing>;
    onClose: () => void;
    error?: string;
  }

  let { open, onCreate, onBrowse, onClose, error }: Props = $props();
  const registry = useServerRegistry();

  let selectedServerId = $state<string>("");
  let current = $state<DirectoryEntry | undefined>(undefined);
  let loading = $state(false);
  let kind = $state<WorkspaceKind>("project");
  let name = $state("");

  let selectedInfo = $derived(selectedServerId ? registry.get(selectedServerId)?.info : undefined);
  let support = $derived(runnerSupport(selectedInfo));
  let incompatibility = $derived(selectedInfo && support === "incompatible" ? incompatibleServerMessage(selectedInfo) : "");

  $effect(() => {
    if (open && !selectedServerId && registry.defaultServerId) {
      selectedServerId = registry.defaultServerId;
    }
  });

  $effect(() => {
    if (open) return;
    current = undefined;
    kind = "project";
    name = "";
  });

  function browseSelectedServer(path: string | undefined, q: string | undefined, cursor: string | undefined) {
    return onBrowse(selectedServerId, path, q, cursor);
  }

  function handleCreate() {
    if (!current || !selectedServerId || incompatibility) return;
    onCreate({ path: current.path, kind, name: name.trim() || undefined }, selectedServerId);
  }
</script>

{#if open}
  <div class="overlay" role="presentation" onclick={onClose} onkeydown={(e) => e.key === "Escape" && onClose()}>
    <div class="dialog" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && onClose()}>
      <h2>Add Workspace</h2>

      {#if registry.servers.length > 1}
        <label>
          Server
          <select bind:value={selectedServerId}>
            <option value="" disabled>-- select --</option>
            {#each registry.servers as conn (conn.config.id)}
              <option value={conn.config.id}>{conn.config.label}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if selectedServerId}
        {#key selectedServerId}
          <DirectoryBrowser
            browse={browseSelectedServer}
            onCurrentChange={(entry) => (current = entry)}
            onLoadingChange={(busy) => (loading = busy)}
          />
        {/key}
      {/if}

      {#if support === "supported"}
        <div class="kind" role="radiogroup" aria-label="Workspace kind">
          <label class="choice"><input type="radio" bind:group={kind} value="project" /> Project</label>
          <label class="choice"><input type="radio" bind:group={kind} value="runner" /> Runner</label>
        </div>
        <label>
          Name (optional)
          <input type="text" bind:value={name} placeholder={current ? defaultWorkspaceName(current.path) : ""} />
        </label>
      {/if}

      {#if incompatibility}
        <p class="error" role="alert">{incompatibility}</p>
      {/if}

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <div class="actions">
        <button type="button" class="cancel" onclick={onClose}>Cancel</button>
        <button type="button" class="create" disabled={!current || !selectedServerId || loading || incompatibility !== ""} onclick={handleCreate}>Use this directory</button>
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

  .kind {
    display: flex;
    gap: var(--sp-3);
  }

  .choice {
    flex-direction: row;
    align-items: center;
    color: var(--fg);
  }

  select,
  input[type="text"] {
    padding: var(--sp-1) var(--sp-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    font-size: 0.85rem;
  }

  select:focus,
  input[type="text"]:focus {
    outline: none;
    border-color: var(--accent);
  }

  .error {
    margin: 0;
    color: #e05252;
    font-size: 0.85rem;
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
