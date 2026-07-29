<script lang="ts">
  import type { Session, Workspace } from "@pty-server/protocol";
  import SessionList from "../../features/sessions/SessionList.svelte";
  import { basename } from "./basename";
  import type { ChromeSlotItem } from "../../registry/types";

  interface Props {
    selectedWorkspace: Workspace | undefined;
    mainSessions: Session[];
    foldedSessions: Session[];
    terminalTitles: Readonly<Record<string, string>>;
    focusedSessionId: string | undefined;
    sidebarItems: ChromeSlotItem[];
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
    onSelectSession,
    onRenameSession,
    onStartDefaultSession,
    onNewSession,
    onClose,
  }: Props = $props();

  let showNewSessionMenu = $state(false);
</script>

<button
  type="button"
  class="drawer-backdrop"
  aria-label="Close session sidebar"
  onclick={onClose}
></button>
<div class="sidebar">
  {#if selectedWorkspace}
    <div class="sidebar-header">
      <span class="sidebar-name">{basename(selectedWorkspace.path)}</span>
      <span class="sidebar-path">{selectedWorkspace.realpath}</span>
    </div>
    <SessionList sessions={mainSessions} {terminalTitles} selectedSessionId={focusedSessionId} onSelect={onSelectSession} onRename={onRenameSession} />
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

<style>
  .sidebar {
    width: 260px;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: var(--sp-2);
    gap: var(--sp-2);
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
  }
</style>
