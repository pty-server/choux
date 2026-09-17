<script lang="ts">
  import { useServerRegistry } from "../../registry/context";
  import { serverAddressSummary } from "../../registry/serverTransport";
  import type { ServerStatus } from "../../registry/types";
  import type { WslServerTools, WslTransport } from "../../registry/wsl";
  import { PTYS_UPDATE_COMMAND, ptysUpdateFor } from "./ptysRelease";
  import { ptysReleaseWatch } from "./ptysReleaseWatch.svelte";
  import { stoppedWslTransport, waitUntilOnline } from "./wslStart";

  interface Props {
    wsl?: WslServerTools;
    onClose: () => void;
    onManage: (focusServerId?: string) => void;
  }

  let { wsl, onClose, onManage }: Props = $props();
  const registry = useServerRegistry();
  let panel = $state<HTMLDivElement>();
  let startingId = $state<string>();
  let startFailures = $state<Record<string, string>>({});

  async function startDistro(id: string, transport: WslTransport) {
    if (!wsl) return;
    startingId = id;
    startFailures[id] = "";
    try {
      await wsl.start(transport);
      await wsl.refresh();
      const online = await waitUntilOnline(() => registry.get(id)?.status, () => registry.refresh(id));
      if (!online) startFailures[id] = `${transport.distro} started, but Choux could not connect to ptys yet.`;
    } catch (err) {
      startFailures[id] = err instanceof Error ? err.message : String(err);
    } finally {
      startingId = undefined;
    }
  }

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
        {@const ptysUpdate = ptysUpdateFor(conn.info?.version, ptysReleaseWatch.latest)}
        {@const stopped = wsl ? stoppedWslTransport(conn, wsl.distros) : undefined}
        <div class="row">
          <button type="button" class="row-main" onclick={() => void registry.setDefault(conn.config.id)}>
            <span class="swatch" style:background={conn.config.accent}></span>
            <span class:online={statusDot(conn.status) === "online"} class:warn={statusDot(conn.status) === "warn"} class:offline={statusDot(conn.status) === "offline"} class="dot"></span>
              <span class="server-details">
              <span>{conn.config.label}</span>
              <span class="url">{serverAddressSummary(conn.config)}</span>
              {#if ptysUpdate}
                <span class="ptys-update" title={`Update with: ${PTYS_UPDATE_COMMAND}`}>ptys {conn.info?.version} → {ptysUpdate} available</span>
              {/if}
              {#if startingId === conn.config.id}
                <span class="starting">Starting...</span>
              {:else if startFailures[conn.config.id]}
                <span class="connection-error" title={startFailures[conn.config.id]}>{startFailures[conn.config.id]}</span>
              {:else if conn.connectionError}
                <span class="connection-error" title={conn.connectionError}>{conn.connectionError}</span>
              {/if}
            </span>
            {#if conn.config.id === registry.defaultServerId}
              <span class="default">Default</span>
              <span class="checkmark" aria-label="Default server">✓</span>
            {/if}
          </button>
          {#if stopped}
            <button
              type="button"
              class="start"
              disabled={startingId === conn.config.id}
              title={`Start WSL distribution ${stopped.distro} and connect`}
              onclick={(event) => { event.stopPropagation(); void startDistro(conn.config.id, stopped); }}
            >{startingId === conn.config.id ? "Starting..." : `Start ${stopped.distro}`}</button>
          {/if}
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

  .url,
  .ptys-update {
    overflow: hidden;
    color: var(--fg-dim);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ptys-update { color: var(--status-warn); }

  .default {
    padding: 2px var(--sp-1);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--fg-dim);
    font-size: 0.7rem;
  }

  .checkmark { color: var(--status-online); }

  .starting {
    overflow: hidden;
    color: var(--status-warn);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .start {
    flex: none;
    margin-right: var(--sp-2);
    padding: 2px var(--sp-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .start:disabled {
    color: var(--fg-dim);
    cursor: default;
  }

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
