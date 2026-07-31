<script lang="ts">
  import type { Session } from "@pty-server/protocol";
  import type { ServerConfig } from "../storage/serverConfigStore";
  import type { ChromeSlotItem } from "../../registry/types";

  interface Props {
    focusedSession: Session | undefined;
    focusedTerminalTitle: string | undefined;
    focusedServerConfig: ServerConfig | undefined;
    focusedDims?: { cols: number; rows: number };
    focusedConnectionState?: "attaching" | "online" | "reconnecting" | "offline" | "exited";
    hasProtocolMismatch: boolean;
    clientProtocolVersion?: number;
    serverProtocolVersion?: number;
    statusItems: ChromeSlotItem[];
  }

  let {
    focusedSession,
    focusedTerminalTitle,
    focusedServerConfig,
    focusedDims,
    focusedConnectionState,
    hasProtocolMismatch,
    clientProtocolVersion,
    serverProtocolVersion,
    statusItems,
  }: Props = $props();
</script>

<div class="statusbar {focusedSession ? 'focused' : ''}" style="--server-accent: {focusedServerConfig?.accent ?? 'transparent'}">
  <div class="statusbar-left">
    {#if focusedSession}
      <span>{focusedSession.name || focusedSession.cmd}</span>
      {#if focusedTerminalTitle}
        <span class="statusbar-terminal-title" title={focusedTerminalTitle}>{focusedTerminalTitle}</span>
      {/if}
      <span class="statusbar-session-id" title={focusedSession.id}>{focusedSession.id}</span>
      {#if focusedServerConfig}
        <span class="statusbar-server-label">{focusedServerConfig.label}</span>
      {/if}
      {#if focusedSession.exited}
        <span class="statusbar-exited">exit {focusedSession.exited.code}{#if focusedSession.exited.signal}, {focusedSession.exited.signal}{/if}</span>
      {/if}
    {/if}
    {#each statusItems as item (item.id)}
      <div data-slot-item={item.id}></div>
    {/each}
  </div>
  <div class="statusbar-right">
    {#if focusedDims}
      <span>{focusedDims.cols}x{focusedDims.rows}</span>
    {/if}
    {#if focusedConnectionState}
      <span class="connection-state">
        <span class="status-dot" data-state={focusedConnectionState}></span>
        {focusedConnectionState}
      </span>
    {/if}
    {#if hasProtocolMismatch}
      <span
        class="protocol-warning"
        title={`Client protocol ${clientProtocolVersion}; server protocol ${serverProtocolVersion}`}
      >⚠ protocol {clientProtocolVersion} vs {serverProtocolVersion}</span>
    {/if}
  </div>
</div>

<style>
  .statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-1) var(--sp-2);
    background: var(--bg-elevated);
    border-top: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--fg-dim);
    min-height: 24px;
  }

  .statusbar-left {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }

  .statusbar.focused {
    border-left: 3px solid var(--server-accent);
  }

  .statusbar-left > * + *,
  .statusbar-right > * + * {
    padding-left: var(--sp-2);
    border-left: 1px solid var(--border);
  }

  .statusbar-session-id {
    flex: 0 0 auto;
    color: var(--fg-dim);
    font-size: 0.7rem;
    font-family: monospace;
    white-space: nowrap;
  }

  .statusbar-terminal-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-dim);
    font-size: 0.8rem;
  }

  .statusbar-server-label {
    color: var(--fg-dim);
    font-size: 0.7rem;
  }

  .statusbar-exited {
    color: #e05252;
    font-size: 0.7rem;
  }

  .statusbar-right {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--sp-2);
  }

  .connection-state {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
  }

  .status-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--status-offline);
  }

  .status-dot[data-state="online"] {
    background: var(--status-online);
  }

  .status-dot[data-state="attaching"],
  .status-dot[data-state="reconnecting"] {
    background: var(--status-warn);
  }

  .protocol-warning {
    color: var(--status-warn);
  }
</style>
