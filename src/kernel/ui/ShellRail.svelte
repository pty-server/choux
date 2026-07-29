<script lang="ts">
  import { workspaceColor } from "./workspaceColor";
  import { basename } from "./basename";
  import type { ChromeSlotItem } from "../../registry/types";
  import type { buildRailModel } from "./railModel";

  interface Props {
    railModel: ReturnType<typeof buildRailModel>;
    selectedServerId: string | undefined;
    selectedWorkspaceId: string | undefined;
    railItems: ChromeSlotItem[];
    onSelectWorkspace: (serverId: string, workspaceId: string) => void;
    onAddWorkspace: () => void;
    onClose: () => void;
  }

  let {
    railModel,
    selectedServerId,
    selectedWorkspaceId,
    railItems,
    onSelectWorkspace,
    onAddWorkspace,
    onClose,
  }: Props = $props();
</script>

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
      <button
        type="button"
        class="workspace-tile {tile.serverId === selectedServerId && tile.workspace.id === selectedWorkspaceId ? 'selected' : ''}"
        style="background: {workspaceColor(tile.workspace.id)}"
        title={`${basename(tile.workspace.path)} - ${tile.serverLabel}`}
        onclick={() => onSelectWorkspace(tile.serverId, tile.workspace.id)}
      >
        <span class="tile-char">{basename(tile.workspace.path).charAt(0).toUpperCase()}</span>
        <span class="tile-status-dot" data-status={tile.status}></span>
        {#if tile.exitBadgeCount > 0}
          <span class="tile-exit-badge">{tile.exitBadgeCount}</span>
        {/if}
      </button>
    {/each}
  {/each}
  {#each railItems as item (item.id)}
    <div data-slot-item={item.id}></div>
  {/each}
  <button type="button" class="add-workspace" aria-label="Add workspace" onclick={onAddWorkspace}>+</button>
</div>

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

  .tile-char {
    position: relative;
    z-index: 1;
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

  .tile-exit-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: var(--status-offline);
    color: #fff;
    font-size: 0.6rem;
    font-weight: 700;
    line-height: 14px;
    text-align: center;
    z-index: 2;
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
