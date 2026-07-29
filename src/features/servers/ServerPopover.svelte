<script lang="ts">
  import { useServerRegistry } from "../../registry/context";
  import type { ServerStatus } from "../../registry/types";

  interface Props {
    onClose: () => void;
    onManage: (focusServerId?: string) => void;
  }

  let { onClose, onManage }: Props = $props();
  const registry = useServerRegistry();
  let panel = $state<HTMLDivElement>();

  function statusDot(status: ServerStatus): "online" | "warn" | "offline" {
    if (status === "online") return "online";
    if (status === "connecting") return "warn";
    return "offline";
  }

  $effect(() => {
    function handleClick(event: MouseEvent) {
      if (panel && event.target instanceof Node && !panel.contains(event.target)) onClose();
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    // Defer the outside-click listener by one macrotask: Svelte 5 flushes
    // effects synchronously right after the opening button's click handler,
    // so that same click still bubbles to window afterward. Registering
    // immediately would let it self-close the popover on the opening click.
    const timer = setTimeout(() => window.addEventListener("click", handleClick), 0);
    window.addEventListener("keydown", handleKeydown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

<div class="popover" bind:this={panel}>
  <div class="servers">
    {#if registry.servers.length === 0}
      <p class="empty">No servers configured</p>
    {:else}
      {#each registry.servers as conn (conn.config.id)}
        <div class="row">
          <button type="button" class="row-main" onclick={() => void registry.setDefault(conn.config.id)}>
            <span class="swatch" style:background={conn.config.accent}></span>
            <span class:online={statusDot(conn.status) === "online"} class:warn={statusDot(conn.status) === "warn"} class:offline={statusDot(conn.status) === "offline"} class="dot"></span>
              <span class="server-details">
              <span>{conn.config.label}</span>
              <span class="url">{conn.config.transport === "local" ? `local instance: ${conn.config.instance}` : conn.config.url}</span>
              {#if conn.connectionError}
                <span class="connection-error" title={conn.connectionError}>{conn.connectionError}</span>
              {/if}
            </span>
            {#if conn.config.id === registry.defaultServerId}
              <span class="default">Default</span>
              <span class="checkmark" aria-label="Default server">✓</span>
            {/if}
          </button>
          <span class="row-actions">
            <button type="button" title="Reconnect" aria-label="Reconnect" onclick={(event) => { event.stopPropagation(); registry.refresh(conn.config.id); }}>↻</button>
            <button type="button" title="Edit server" aria-label="Edit server" onclick={(event) => { event.stopPropagation(); onManage(conn.config.id); }}>✎</button>
          </span>
        </div>
      {/each}
    {/if}
  </div>
  <button type="button" class="manage" onclick={() => onManage()}>Manage servers</button>
</div>

<style>
  .popover {
    position: absolute;
    top: 100%;
    right: var(--sp-2);
    z-index: 90;
    min-width: 280px;
    margin-top: var(--sp-1);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }

  .servers {
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }

  .row-main {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2);
    background: none;
    border: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row:hover .row-main,
  .row:focus-within .row-main {
    background: var(--bg);
  }

  .swatch {
    width: 10px;
    height: 10px;
    flex: none;
    border-radius: 2px;
  }

  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
  }

  .connection-error {
    overflow: hidden;
    color: var(--status-offline);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot.online { background: var(--status-online); }
  .dot.warn { background: var(--status-warn); }
  .dot.offline { background: var(--status-offline); }

  .server-details {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 2px;
  }

  .url {
    overflow: hidden;
    color: var(--fg-dim);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .default {
    padding: 2px var(--sp-1);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--fg-dim);
    font-size: 0.7rem;
  }

  .checkmark { color: var(--status-online); }

  .row-actions {
    display: flex;
    gap: var(--sp-1);
    padding-right: var(--sp-2);
    opacity: 0;
  }

  .row:hover .row-actions,
  .row:focus-within .row-actions { opacity: 1; }

  .row-actions button {
    padding: 2px var(--sp-1);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    cursor: pointer;
  }

  .empty {
    margin: 0;
    padding: var(--sp-3);
    color: var(--fg-dim);
    font-size: 0.85rem;
  }

  .manage {
    width: 100%;
    padding: var(--sp-2);
    background: var(--bg);
    border: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
</style>
