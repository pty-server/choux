<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Session } from "@pty-server/protocol";

  interface Props {
    sessions: Session[];
    sortKey?: (session: Session) => number;
    selectedSessionId?: string;
    terminalTitles?: Readonly<Record<string, string>>;
    onSelect?: (session: Session) => void;
    onRename?: (session: Session) => void;
    sessionExtra?: Snippet<[Session]>;
  }

  let { sessions, sortKey = (session) => session.exited?.at ?? session.createdAt, selectedSessionId, terminalTitles = {}, onSelect, onRename, sessionExtra }: Props = $props();
  let sortedSessions = $derived([...sessions].sort((a, b) => sortKey(b) - sortKey(a)));
  let contextMenu = $state<{ session: Session; x: number; y: number } | undefined>(undefined);

  function title(session: Session): string {
    const value = session.name || [session.cmd, ...session.args].join(" ");
    return value.length > 60 ? `${value.slice(0, 59)}…` : value;
  }

  function statusLabel(session: Session): string {
    if (!session.exited) return "Running";
    return `Exited with code ${session.exited.code}${session.exited.signal ? `, signal ${session.exited.signal}` : ""}`;
  }

  function openContextMenu(event: MouseEvent, session: Session): void {
    if (!onRename) return;
    event.preventDefault();
    contextMenu = {
      session,
      x: Math.min(event.clientX, window.innerWidth - 156),
      y: Math.min(event.clientY, window.innerHeight - 48),
    };
  }
</script>

<svelte:window onclick={() => contextMenu = undefined} onkeydown={(event) => event.key === "Escape" && (contextMenu = undefined)} />

<ul>
  {#each sortedSessions as session (session.id)}
    <li class:clickable={!!onSelect} class:current={session.id === selectedSessionId} oncontextmenu={(event) => openContextMenu(event, session)}>
      <div class="row">
        <button type="button" class="select" onclick={() => onSelect?.(session)}>
          <span class="session-labels">
            <span class="title">{title(session)}</span>
            {#if terminalTitles[session.id]}
              <span class="terminal-title" title={terminalTitles[session.id]}>{terminalTitles[session.id]}</span>
            {/if}
          </span>
          <span
            class:running={!session.exited}
            class:exited={!!session.exited}
            class="status-icon"
            aria-label={statusLabel(session)}
            title={statusLabel(session)}
          >{session.exited ? "×" : "●"}</span>
        </button>
      </div>
      {#if sessionExtra}
        {@render sessionExtra(session)}
      {/if}
    </li>
  {/each}
</ul>

{#if contextMenu}
  <div class="context-menu" role="menu" tabindex="-1" style={`left: ${contextMenu.x}px; top: ${contextMenu.y}px`}>
    <button type="button" role="menuitem" onclick={() => { onRename?.(contextMenu!.session); contextMenu = undefined; }}>Rename session</button>
  </div>
{/if}

<style>
  ul {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  li {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  li.current {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, var(--bg-elevated));
  }

  .row {
    display: flex;
    width: 100%;
    align-items: center;
    background: none;
    border: none;
    font: inherit;
    color: var(--fg);
    text-align: left;
  }

  .select {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2);
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .session-labels {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title,
  .terminal-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .terminal-title {
    color: var(--fg-dim);
    font-size: 0.8rem;
  }

  .status-icon {
    flex: 0 0 auto;
    font-size: 0.9rem;
    line-height: 1;
  }

  .status-icon.running {
    color: var(--status-online);
  }

  .status-icon.exited {
    color: var(--fg-dim);
  }

  .context-menu {
    position: fixed;
    z-index: 200;
    min-width: 150px;
    padding: var(--sp-1);
    border: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-elevated);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.24);
  }

  .context-menu button {
    width: 100%;
    padding: var(--sp-2);
    border: none;
    border-radius: 2px;
    background: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .context-menu button:hover,
  .context-menu button:focus-visible {
    background: var(--bg);
  }
</style>
