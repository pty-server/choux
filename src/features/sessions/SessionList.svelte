<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Session } from "@pty-server/protocol";
  import type { SessionDropPosition } from "../../registry/types";

  interface Props {
    sessions: Session[];
    sortKey?: (session: Session) => number;
    selectedSessionId?: string;
    terminalTitles?: Readonly<Record<string, string>>;
    onSelect?: (session: Session) => void;
    onRename?: (session: Session) => void;
    onRemove?: (session: Session) => void;
    onReorder?: (movedSessionId: string, targetSessionId: string, position: SessionDropPosition) => void;
    sessionExtra?: Snippet<[Session]>;
  }

  let { sessions, sortKey = (session) => session.exited?.at ?? session.createdAt, selectedSessionId, terminalTitles = {}, onSelect, onRename, onRemove, onReorder, sessionExtra }: Props = $props();
  let sortedSessions = $derived(onReorder ? sessions : [...sessions].sort((a, b) => sortKey(b) - sortKey(a)));
  let contextMenu = $state<{ session: Session; x: number; y: number } | undefined>(undefined);
  let draggedSessionId = $state<string | undefined>(undefined);
  let dropTarget = $state<{ sessionId: string; position: SessionDropPosition } | undefined>(undefined);

  function title(session: Session): string {
    const value = session.name || [session.cmd, ...session.args].join(" ");
    return value.length > 60 ? `${value.slice(0, 59)}…` : value;
  }

  function statusLabel(session: Session): string {
    if (!session.exited) return "Running";
    return `Exited with code ${session.exited.code}${session.exited.signal ? `, signal ${session.exited.signal}` : ""}`;
  }

  function startDrag(event: DragEvent, session: Session): void {
    if (!onReorder) return;
    draggedSessionId = session.id;
    event.dataTransfer?.setData("text/plain", session.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function endDrag(): void {
    draggedSessionId = undefined;
    dropTarget = undefined;
  }

  function trackDragOver(event: DragEvent, session: Session): void {
    if (!onReorder || draggedSessionId === undefined || draggedSessionId === session.id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropTarget = {
      sessionId: session.id,
      position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    };
  }

  function finishDrop(event: DragEvent, session: Session): void {
    if (!onReorder || draggedSessionId === undefined) return;
    event.preventDefault();
    const position = dropTarget?.sessionId === session.id ? dropTarget.position : "before";
    const movedSessionId = draggedSessionId;
    endDrag();
    if (movedSessionId !== session.id) onReorder(movedSessionId, session.id, position);
  }

  function canRemove(session: Session): boolean {
    return !!onRemove && session.exited !== undefined;
  }

  function openContextMenu(event: MouseEvent, session: Session): void {
    if (!onRename && !canRemove(session)) return;
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
    <li
      class:clickable={!!onSelect}
      class:current={session.id === selectedSessionId}
      class:dragged={session.id === draggedSessionId}
      class:drop-before={dropTarget?.sessionId === session.id && dropTarget.position === "before"}
      class:drop-after={dropTarget?.sessionId === session.id && dropTarget.position === "after"}
      draggable={!!onReorder}
      oncontextmenu={(event) => openContextMenu(event, session)}
      ondragstart={(event) => startDrag(event, session)}
      ondragover={(event) => trackDragOver(event, session)}
      ondragleave={() => { if (dropTarget?.sessionId === session.id) dropTarget = undefined; }}
      ondrop={(event) => finishDrop(event, session)}
      ondragend={endDrag}
    >
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
    {#if onRename}
      <button type="button" role="menuitem" onclick={() => { onRename(contextMenu!.session); contextMenu = undefined; }}>Rename session</button>
    {/if}
    {#if canRemove(contextMenu.session)}
      <button type="button" role="menuitem" class="destructive" onclick={() => { onRemove!(contextMenu!.session); contextMenu = undefined; }}>Remove session</button>
    {/if}
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

  li[draggable="true"] {
    cursor: grab;
  }

  li.dragged {
    opacity: 0.5;
  }

  li.drop-before {
    box-shadow: inset 0 2px 0 0 var(--accent);
  }

  li.drop-after {
    box-shadow: inset 0 -2px 0 0 var(--accent);
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

  .context-menu button.destructive {
    color: #e05252;
  }
</style>
