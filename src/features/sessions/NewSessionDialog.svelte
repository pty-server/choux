<script lang="ts">
  import type { DirectoryEntry, DirectoryListing, Workspace } from "@pty-server/protocol";
  import { useServerRegistry } from "../../registry/context";
  import { incompatibleServerMessage, runnerSupport } from "../../registry/protocolSupport";
  import { formatArgs, parseArgsString, type SessionProfile } from "../../registry/sessionProfiles";
  import { cwdFieldValue } from "./cwdField";
  import DirectoryBrowser from "./DirectoryBrowser.svelte";

  interface Props {
    open: boolean;
    workspace: Workspace | undefined;
    serverId: string | undefined;
    onCreate: (input: {
      workspaceId: string;
      cwd?: string;
      cmd?: string;
      args?: string[];
      env?: Record<string, string>;
      name?: string;
      serverId: string;
    }) => void;
    onBrowse: (
      serverId: string,
      path: string | undefined,
      q: string | undefined,
      cursor: string | undefined,
      workspaceId: string | undefined,
    ) => Promise<DirectoryListing>;
    onClose: () => void;
    error?: string;
    profiles?: SessionProfile[];
  }

  let { open, workspace, serverId, onCreate, onBrowse, onClose, error, profiles = [] }: Props = $props();
  const registry = useServerRegistry();

  let cmd = $state("");
  let argsStr = $state("");
  let name = $state("");
  // "" is the Custom entry, so opening the dialog never prefills silently.
  let selectedProfileId = $state("");
  let env = $state<Record<string, string> | undefined>(undefined);
  let cwd = $state("");
  let browsing = $state(false);
  let picked = $state<DirectoryEntry | undefined>(undefined);

  let envKeys = $derived(env ? Object.keys(env) : []);
  let serverInfo = $derived(serverId ? registry.get(serverId)?.info : undefined);
  let support = $derived(runnerSupport(serverInfo));
  let incompatibility = $derived(serverInfo && support === "incompatible" ? incompatibleServerMessage(serverInfo) : "");

  let workspaceId = $derived(workspace?.id);

  $effect(() => {
    void open;
    void workspaceId;
    cwd = "";
    browsing = false;
  });

  function selectProfile(id: string) {
    selectedProfileId = id;
    const profile = profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      cmd = "";
      argsStr = "";
      name = "";
      env = undefined;
      return;
    }
    cmd = profile.cmd;
    argsStr = formatArgs(profile.args);
    name = profile.name;
    env = profile.env;
  }

  function browseWorkspace(path: string | undefined, q: string | undefined, cursor: string | undefined) {
    if (!serverId || !workspace) return Promise.reject(new Error("No workspace selected."));
    return onBrowse(serverId, path, q, cursor, workspace.id);
  }

  function usePicked() {
    if (!picked || !workspace) return;
    cwd = cwdFieldValue(picked.path, workspace.realpath);
    browsing = false;
  }

  function handleCreate() {
    if (!workspace || !serverId || incompatibility) return;
    const args = parseArgsString(argsStr);
    onCreate({
      workspaceId: workspace.id,
      cwd: support === "supported" && cwd.trim() ? cwd.trim() : undefined,
      cmd: cmd || undefined,
      args: args.length > 0 ? args : undefined,
      env: envKeys.length > 0 ? env : undefined,
      name: name || undefined,
      serverId,
    });
  }

  function handleCancel() {
    onClose();
  }
</script>

{#if open}
  <div class="overlay" role="presentation" onclick={handleCancel} onkeydown={(e) => e.key === "Escape" && handleCancel()}>
    <div class="dialog" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && handleCancel()}>
      <h2>New Session</h2>

      {#if profiles.length > 0}
        <label>
          Profile
          <select value={selectedProfileId} onchange={(e) => selectProfile(e.currentTarget.value)}>
            <option value="">Custom</option>
            {#each profiles as profile (profile.id)}
              <option value={profile.id}>{profile.name}</option>
            {/each}
          </select>
        </label>
      {/if}

      <label>
        Command (optional)
        <input type="text" bind:value={cmd} placeholder="Default shell" />
      </label>

      <label>
        Args (space-separated)
        <input type="text" bind:value={argsStr} placeholder="e.g. -i --login" />
      </label>

      <label>
        Name (optional)
        <input type="text" bind:value={name} placeholder="e.g. dev shell" />
      </label>

      {#if support === "supported" && workspace}
        <div class="directory-field">
          <label for="new-session-cwd">Directory (optional)</label>
          <div class="directory-input">
            <input id="new-session-cwd" type="text" bind:value={cwd} placeholder={workspace.realpath} />
            <button type="button" class="browse" aria-expanded={browsing} onclick={() => { picked = undefined; browsing = !browsing; }}>Browse</button>
          </div>
        </div>
        {#if browsing}
          <DirectoryBrowser scoped browse={browseWorkspace} onCurrentChange={(entry) => (picked = entry)} />
          <div class="browse-actions">
            <button type="button" class="browse" disabled={!picked} onclick={usePicked}>Use this directory</button>
          </div>
        {/if}
      {/if}

      {#if envKeys.length > 0}
        <p class="env-hint">Environment: {envKeys.join(", ")} (from profile)</p>
      {/if}

      {#if incompatibility}
        <p class="error" role="alert">{incompatibility}</p>
      {/if}

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <div class="actions">
        <button type="button" class="cancel" onclick={handleCancel}>Cancel</button>
        <button type="button" class="create" disabled={!workspace || !serverId || incompatibility !== ""} onclick={handleCreate}>Create</button>
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

  input,
  select {
    padding: var(--sp-1) var(--sp-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    font-size: 0.85rem;
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .directory-field {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .directory-input {
    display: flex;
    gap: var(--sp-2);
  }

  .directory-input input {
    flex: 1;
    min-width: 0;
  }

  .browse-actions {
    display: flex;
    justify-content: flex-end;
  }

  .env-hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--fg-dim);
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

  .browse {
    background: var(--bg);
    color: var(--fg);
  }

  .browse:disabled {
    opacity: 0.4;
    cursor: not-allowed;
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
