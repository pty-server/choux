<script lang="ts">
  import type { Session } from "@pty-server/protocol";

  interface Props {
    open: boolean;
    session: Session | undefined;
    onRename: (sessionId: string, name: string) => Promise<void>;
    onClose: () => void;
  }

  let { open, session, onRename, onClose }: Props = $props();

  let name = $state("");
  let saving = $state(false);
  let error = $state("");

  function displayName(value: Session): string {
    return value.name || [value.cmd, ...value.args].join(" ");
  }

  $effect(() => {
    if (!open || !session) return;
    name = displayName(session);
    error = "";
  });

  async function save() {
    if (!session || saving) return;
    const nextName = name.trim();
    if (!nextName) {
      error = "Enter a session name.";
      return;
    }
    saving = true;
    error = "";
    try {
      await onRename(session.id, nextName);
      onClose();
    } catch (err) {
      error = err instanceof Error ? err.message : "Unable to rename the session.";
    } finally {
      saving = false;
    }
  }
</script>

{#if open && session}
  <div class="overlay" role="presentation" onclick={() => !saving && onClose()} onkeydown={(event) => event.key === "Escape" && !saving && onClose()}>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="rename-session-title" tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.key === "Escape" && !saving && onClose()}>
      <h2 id="rename-session-title">Rename Session</h2>
      <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>
          Session name
          <input type="text" bind:value={name} maxlength="120" disabled={saving} />
        </label>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <div class="actions">
          <button type="button" class="cancel" disabled={saving} onclick={onClose}>Cancel</button>
          <button type="submit" class="save" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }

  .dialog {
    min-width: 320px;
    max-width: 90vw;
    padding: var(--sp-4);
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-elevated);
  }

  h2 {
    margin: 0 0 var(--sp-3);
    color: var(--fg);
    font-size: 1rem;
  }

  form,
  label {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  label {
    color: var(--fg-dim);
    font-size: 0.85rem;
  }

  input {
    padding: var(--sp-1) var(--sp-2);
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }

  input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .error {
    margin: 0;
    color: var(--status-offline);
    font-size: 0.8rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
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
    color: var(--fg);
  }

  .save {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--bg);
  }
</style>
