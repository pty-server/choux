<script lang="ts">
  interface Props {
    open: boolean;
    workspaceId: string | undefined;
    serverId: string | undefined;
    onCreate: (input: { workspaceId: string; cmd?: string; args?: string[]; name?: string; serverId: string }) => void;
    onClose: () => void;
  }

  let { open, workspaceId, serverId, onCreate, onClose }: Props = $props();

  let cmd = $state("");
  let argsStr = $state("");
  let name = $state("");

  function handleCreate() {
    if (!workspaceId || !serverId) return;
    const args = argsStr.split(/\s+/).filter((a) => a.length > 0);
    onCreate({ workspaceId, cmd: cmd || undefined, args: args.length > 0 ? args : undefined, name: name || undefined, serverId });
  }

  function handleCancel() {
    onClose();
  }
</script>

{#if open}
  <div class="overlay" role="presentation" onclick={handleCancel} onkeydown={(e) => e.key === "Escape" && handleCancel()}>
    <div class="dialog" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && handleCancel()}>
      <h2>New Session</h2>

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
