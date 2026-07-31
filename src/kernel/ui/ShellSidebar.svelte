<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Session, Workspace } from "@pty-server/protocol";
  import SessionList from "../../features/sessions/SessionList.svelte";
  import { basename } from "../../registry/basename";
  import { defaultSidebarWidth, maxSidebarWidth, minSidebarWidth } from "../storage/sidebarWidthStore";
  import type { ChromeSlotItem } from "../../registry/types";

  interface Props {
    selectedWorkspace: Workspace | undefined;
    mainSessions: Session[];
    foldedSessions: Session[];
    terminalTitles: Readonly<Record<string, string>>;
    focusedSessionId: string | undefined;
    sidebarItems: ChromeSlotItem[];
    sessionExtra?: Snippet<[Session]>;
    width: number;
    onResize: (width: number) => void;
    onResizeEnd: () => void;
    onSelectSession: (session: Session) => void;
    onRenameSession: (session: Session) => void;
    onStartDefaultSession: () => void;
    onNewSession: () => void;
    onClose: () => void;
  }

  let {
    selectedWorkspace,
    mainSessions,
    foldedSessions,
    terminalTitles,
    focusedSessionId,
    sidebarItems,
    sessionExtra,
    width,
    onResize,
    onResizeEnd,
    onSelectSession,
    onRenameSession,
    onStartDefaultSession,
    onNewSession,
    onClose,
  }: Props = $props();

  let showNewSessionMenu = $state(false);
  let dragging = $state(false);

  const keyboardStep = 16;

  function startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = width;
    dragging = true;
    handle.setPointerCapture(event.pointerId);

    const move = (moved: PointerEvent): void => onResize(startWidth + (moved.clientX - startX));
    const stop = (): void => {
      dragging = false;
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      onResizeEnd();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function resizeByKey(event: KeyboardEvent): void {
    const delta = event.key === "ArrowLeft" ? -keyboardStep : event.key === "ArrowRight" ? keyboardStep : 0;
    if (delta === 0 && event.key !== "Home") return;
    event.preventDefault();
    onResize(event.key === "Home" ? defaultSidebarWidth : width + delta);
    onResizeEnd();
  }
</script>

<button
  type="button"
  class="drawer-backdrop"
  aria-label="Close session sidebar"
  onclick={onClose}
></button>
<div class="sidebar" style:width={`${width}px`}>
  <div class="sidebar-content">
    {#if selectedWorkspace}
    <div class="sidebar-header">
      <span class="sidebar-name">{basename(selectedWorkspace.path)}</span>
      <span class="sidebar-path">{selectedWorkspace.realpath}</span>
    </div>
    <SessionList sessions={mainSessions} {terminalTitles} {sessionExtra} selectedSessionId={focusedSessionId} onSelect={onSelectSession} onRename={onRenameSession} />
    <div class="new-session-control">
      <button type="button" class="new-session" onclick={() => { showNewSessionMenu = false; onStartDefaultSession(); }}>New session</button>
      <button
        type="button"
        class="new-session-menu-toggle"
        aria-label="New session options"
        aria-expanded={showNewSessionMenu}
        onclick={() => (showNewSessionMenu = !showNewSessionMenu)}
      >
        &#9662;
      </button>
      {#if showNewSessionMenu}
        <div class="new-session-menu" role="menu">
          <button type="button" role="menuitem" onclick={() => { showNewSessionMenu = false; onNewSession(); }}>Configure session…</button>
        </div>
      {/if}
    </div>
    {#if foldedSessions.length > 0}
      <details>
        <summary>Recently exited ({foldedSessions.length})</summary>
        <SessionList sessions={foldedSessions} {terminalTitles} selectedSessionId={focusedSessionId} onSelect={onSelectSession} onRename={onRenameSession} />
      </details>
    {/if}
    {#each sidebarItems as item (item.id)}
      <div data-slot-item={item.id}></div>
    {/each}
    {:else}
      <div class="sidebar-empty">Select a workspace</div>
    {/if}
  </div>
  <div
    class="resize-handle"
    class:dragging
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    aria-valuenow={width}
    aria-valuemin={minSidebarWidth}
    aria-valuemax={maxSidebarWidth}
    tabindex="0"
    onpointerdown={startResize}
    onkeydown={resizeByKey}
    ondblclick={() => { onResize(defaultSidebarWidth); onResizeEnd(); }}
  ></div>
</div>

<style>
  .sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    max-width: 85vw;
    background: var(--bg);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }

  .sidebar-content {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    overflow-y: auto;
    padding: var(--sp-2);
    gap: var(--sp-2);
  }

  .resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 6px;
    z-index: 1;
    cursor: col-resize;
    touch-action: none;
  }

  .resize-handle:hover,
  .resize-handle:focus-visible,
  .resize-handle.dragging {
    background: var(--accent);
    outline: none;
  }

  .sidebar-header {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    padding-bottom: var(--sp-2);
    border-bottom: 1px solid var(--border);
  }

  .sidebar-name {
    font-weight: 700;
    font-size: 0.95rem;
    color: var(--fg);
  }

  .sidebar-path {
    font-size: 0.75rem;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .new-session {
    padding: var(--sp-1) var(--sp-3);
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 4px 0 0 4px;
    cursor: pointer;
    font: inherit;
  }

  .new-session:hover {
    opacity: 0.9;
  }

  .new-session-control {
    position: relative;
    align-self: center;
    display: flex;
  }

  .new-session-menu-toggle {
    padding: var(--sp-1) var(--sp-2);
    background: var(--accent);
    color: #fff;
    border: none;
    border-left: 1px solid color-mix(in srgb, #000 20%, transparent);
    border-radius: 0 4px 4px 0;
    cursor: pointer;
    font: inherit;
    font-size: 0.75rem;
  }

  .new-session-menu-toggle:hover {
    opacity: 0.9;
  }

  .new-session-menu {
    position: absolute;
    top: calc(100% + var(--sp-1));
    left: 0;
    z-index: 2;
    min-width: max-content;
    padding: var(--sp-1);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  .new-session-menu button {
    width: 100%;
    padding: var(--sp-1) var(--sp-2);
    background: transparent;
    color: var(--fg);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }

  .new-session-menu button:hover {
    background: var(--bg);
  }

  .sidebar-empty {
    color: var(--fg-dim);
    font-size: 0.85rem;
    padding: var(--sp-3) 0;
    text-align: center;
  }

  details {
    border-top: 1px solid var(--border);
    padding-top: var(--sp-2);
  }

  summary {
    font-size: 0.8rem;
    color: var(--fg-dim);
    cursor: pointer;
    padding: var(--sp-1) 0;
  }

  /* Off-canvas drawer backdrop - a real (clickable) element rather than a
     ::before pseudo-element, since closing the drawer on click requires an
     onclick handler. Hidden by default (desktop: the sidebar is an inline
     flex column, no backdrop needed); only shown as a full-viewport overlay
     under the mobile breakpoint below. */
  .drawer-backdrop {
    display: none;
  }

  @media (max-width: 640px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 50;
      box-shadow: 4px 0 12px rgba(0, 0, 0, 0.4);
    }

    .drawer-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 40;
      border: none;
      padding: 0;
      background: rgba(0, 0, 0, 0.3);
    }

    .resize-handle {
      display: none;
    }
  }
</style>
