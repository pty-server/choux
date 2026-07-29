<script lang="ts">
  interface Props {
    open: boolean;
    toolAvailable: boolean;
    npmAvailable: boolean;
    busy?: boolean;
    message?: string;
    onInstall: () => void;
    onStart: () => void;
    onRetry: () => void;
    onClose: () => void;
  }

  let { open, toolAvailable, npmAvailable, busy = false, message, onInstall, onStart, onRetry, onClose }: Props = $props();
</script>

{#if open}
  <div class="overlay" role="presentation" onclick={onClose} onkeydown={(event) => event.key === "Escape" && onClose()}>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="local-server-title" tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()}>
      <h2 id="local-server-title">No local ptys server is running</h2>
      {#if toolAvailable}
        <p>Start a local, network-private daemon and Choux will connect through its control socket.</p>
      {:else if npmAvailable}
        <p>Install the ptys command from npm, then start a local daemon.</p>
      {:else}
        <p>Install <code>ptys</code> and make it available on PATH, then retry.</p>
        <code>npm install --global ptys@latest</code>
      {/if}
      {#if message}<p class="message" role="alert">{message}</p>{/if}
      <div class="actions">
        <button type="button" onclick={onClose} disabled={busy}>Not now</button>
        <button type="button" onclick={onRetry} disabled={busy}>Retry</button>
        {#if !toolAvailable && npmAvailable}
          <button type="button" class="primary" onclick={onInstall} disabled={busy}>Install ptys from npm</button>
        {:else if toolAvailable}
          <button type="button" class="primary" onclick={onStart} disabled={busy}>Start local server</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; background: rgba(0, 0, 0, 0.55); }
  .dialog { width: min(440px, calc(100vw - 2rem)); display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); color: var(--fg); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; }
  h2, p { margin: 0; }
  p { color: var(--fg-dim); line-height: 1.45; }
  code { padding: var(--sp-1); color: var(--fg); background: var(--bg); border-radius: 3px; overflow-wrap: anywhere; }
  .message { color: var(--status-warn); }
  .actions { display: flex; justify-content: flex-end; gap: var(--sp-2); flex-wrap: wrap; }
  button { padding: var(--sp-1) var(--sp-3); color: var(--fg-dim); background: var(--bg); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; }
  button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: wait; }
</style>
