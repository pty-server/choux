<script lang="ts">
  import { workspaceColor } from "./workspaceColor";
  import type { ChromeSlotItem } from "../../registry/types";
  import type { buildRailModel, RailTile } from "./railModel";

  interface Props {
    railModel: ReturnType<typeof buildRailModel>;
    selectedServerId: string | undefined;
    selectedWorkspaceId: string | undefined;
    railItems: ChromeSlotItem[];
    onSelectWorkspace: (serverId: string, workspaceId: string) => void;
    onAddWorkspace: () => void;
    onCloseWorkspace?: (serverId: string, workspaceId: string) => void;
    onClose: () => void;
  }

  let {
    railModel,
    selectedServerId,
    selectedWorkspaceId,
    railItems,
    onSelectWorkspace,
    onAddWorkspace,
    onCloseWorkspace,
    onClose,
  }: Props = $props();

  let contextMenu = $state<{ key: string; x: number; y: number } | undefined>(undefined);
  let menuTile = $derived(
    contextMenu && railModel.groups.flatMap((group) => [...group.tiles, ...group.runners]).find((tile) => tile.key === contextMenu?.key),
  );

  function openContextMenu(event: MouseEvent, tile: RailTile): void {
    if (!onCloseWorkspace) return;
    event.preventDefault();
    contextMenu = {
      key: tile.key,
      x: Math.min(event.clientX, window.innerWidth - 216),
      y: Math.min(event.clientY, window.innerHeight - 96),
    };
  }
</script>

<svelte:window onclick={() => contextMenu = undefined} onkeydown={(event) => event.key === "Escape" && (contextMenu = undefined)} />

{#snippet workspaceTile(tile: RailTile)}
  <button
    type="button"
    class="workspace-tile {tile.serverId === selectedServerId && tile.workspace.id === selectedWorkspaceId ? 'selected' : ''}"
    style="background: {workspaceColor(tile.workspace.id)}"
    title={`${tile.workspace.name}${tile.workspace.kind === "runner" ? " (runner)" : ""} - ${tile.serverLabel}`}
    onclick={() => onSelectWorkspace(tile.serverId, tile.workspace.id)}
    oncontextmenu={(event) => openContextMenu(event, tile)}
  >
    <span class="tile-char">{tile.workspace.name.charAt(0).toUpperCase()}</span>
    {#if tile.workspace.kind === "runner"}<span class="tile-kind-badge" aria-hidden="true">&#9654;</span>{/if}
    <span class="tile-status-dot" data-status={tile.status}></span>
  </button>
{/snippet}

<button
  type="button"
  class="drawer-backdrop"
  aria-label="Close workspace rail"
  onclick={onClose}
></button>
<div class="rail">
  {#each railModel.groups as group, groupIndex (group.serverId)}
    {#if groupIndex > 0}
      <div class="server-divider" aria-hidden="true"></div>
    {/if}
    {#each group.tiles as tile (tile.key)}
      {@render workspaceTile(tile)}
    {/each}
    {#if group.tiles.length > 0 && group.runners.length > 0}
      <div class="kind-divider" aria-hidden="true"></div>
    {/if}
    {#each group.runners as tile (tile.key)}
      {@render workspaceTile(tile)}
    {/each}
  {/each}
  {#each railItems as item (item.id)}
    <div data-slot-item={item.id}></div>
  {/each}
  <button type="button" class="add-workspace" aria-label="Add workspace" onclick={onAddWorkspace}>+</button>
</div>

{#if contextMenu && menuTile && onCloseWorkspace}
  {@const tile = menuTile}
  <div class="context-menu" role="menu" tabindex="-1" style={`left: ${contextMenu.x}px; top: ${contextMenu.y}px`}>
    <button
      type="button"
      role="menuitem"
      class="destructive"
      disabled={tile.closeBlocker !== undefined}
      onclick={() => { onCloseWorkspace(tile.serverId, tile.workspace.id); contextMenu = undefined; }}
    >Close workspace</button>
    {#if tile.closeBlocker}
      <p class="context-menu-hint">{tile.closeBlocker}</p>
    {/if}
  </div>
{/if}

<style>
  .rail {
    width: 56px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-1);
    padding: var(--sp-2) 0;
    background: var(--bg);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }

  .workspace-tile {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 0.9rem;
    font-weight: 600;
    position: relative;
    flex-shrink: 0;
  }

  .workspace-tile.selected {
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 75%, transparent);
  }

  .workspace-tile:hover {
    opacity: 0.85;
  }

  .workspace-tile:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .server-divider {
    width: 28px;
    height: 1px;
    background: var(--border);
    margin: var(--sp-1) 0;
    flex-shrink: 0;
  }

  .kind-divider {
    width: 16px;
    border-top: 1px dashed var(--border);
    margin: 2px 0;
    flex-shrink: 0;
  }

  .tile-char {
    position: relative;
    z-index: 1;
  }

  .tile-kind-badge {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 0.8rem;
    height: 0.8rem;
    border-radius: 50%;
    border: 1.5px solid var(--bg);
    background: var(--bg-elevated);
    color: var(--fg);
    font-size: 0.4rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2;
  }

  .tile-status-dot {
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    border: 1.5px solid var(--bg);
    background: var(--status-offline);
    z-index: 2;
  }

  .tile-status-dot[data-status="online"] {
    background: var(--status-online);
  }

  .tile-status-dot[data-status="warn"] {
    background: var(--status-warn);
  }

  .add-workspace {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    border: 1px dashed var(--border);
    background: none;
    color: var(--fg-dim);
    cursor: pointer;
    font-size: 1.1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .add-workspace:hover {
    color: var(--fg);
    border-color: var(--fg-dim);
  }

  .context-menu {
    position: fixed;
    z-index: 200;
    width: 200px;
    padding: var(--sp-1);
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

  .context-menu button:hover:enabled,
  .context-menu button:focus-visible {
    background: var(--bg);
  }

  .context-menu button.destructive {
    color: #e05252;
  }

  .context-menu button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .context-menu-hint {
    margin: 0;
    padding: 0 var(--sp-2) var(--sp-1);
    color: var(--fg-dim);
    font-size: 0.75rem;
  }

  /* Off-canvas drawer backdrop - a real (clickable) element rather than a
     ::before pseudo-element, since closing the drawer on click requires an
     onclick handler. Hidden by default (desktop: the rail is an inline flex
     column, no backdrop needed); only shown as a full-viewport overlay under
     the mobile breakpoint below. */
  .drawer-backdrop {
    display: none;
  }

  @media (max-width: 640px) {
    .rail {
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
