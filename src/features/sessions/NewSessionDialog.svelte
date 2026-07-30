<script lang="ts">
  import { formatArgs, parseArgsString, type SessionProfile } from "../../registry/sessionProfiles";

  interface Props {
    open: boolean;
    workspaceId: string | undefined;
    serverId: string | undefined;
    onCreate: (input: {
      workspaceId: string;
      cmd?: string;
      args?: string[];
      env?: Record<string, string>;
      name?: string;
      serverId: string;
    }) => void;
    onClose: () => void;
    profiles?: SessionProfile[];
  }

  let { open, workspaceId, serverId, onCreate, onClose, profiles = [] }: Props = $props();

  let cmd = $state("");
  let argsStr = $state("");
  let name = $state("");
  // "" is the Custom entry, so opening the dialog never prefills silently.
  let selectedProfileId = $state("");
  let env = $state<Record<string, string> | undefined>(undefined);

  let envKeys = $derived(env ? Object.keys(env) : []);

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

  function handleCreate() {
    if (!workspaceId || !serverId) return;
    const args = parseArgsString(argsStr);
    onCreate({
      workspaceId,
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

      {#if envKeys.length > 0}
        <p class="env-hint">Environment: {envKeys.join(", ")} (from profile)</p>
      {/if}

      <div class="actions">
        <button type="button" class="cancel" onclick={handleCancel}>Cancel</button>
        <button type="button" class="create" disabled={!workspaceId || !serverId} onclick={handleCreate}>Create</button>
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

  .env-hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--fg-dim);
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
