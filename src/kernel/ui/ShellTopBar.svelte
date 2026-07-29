<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import ServerPopover from "../../features/servers/ServerPopover.svelte";
  import type { AggregateServerStatus } from "../../registry/types";

  interface Props {
    aggregateStatus: AggregateServerStatus;
    settingsOpen: boolean;
    onToggleSettings: () => void;
    onToggleRail: () => void;
    onToggleSidebar: () => void;
    onManageServers: (focusServerId?: string) => void;
    topBar?: Snippet;
  }

  let {
    aggregateStatus,
    settingsOpen,
    onToggleSettings,
    onToggleRail,
    onToggleSidebar,
    onManageServers,
    topBar,
  }: Props = $props();

  let showServerPopover = $state(false);
  let isMaximized = $state(false);

  function isTauriWindow(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  }

  async function withCurrentWindow(action: (appWindow: import("@tauri-apps/api/window").Window) => Promise<void>) {
    if (!isTauriWindow()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await action(getCurrentWindow());
  }

  function startWindowDrag(event: MouseEvent) {
    if (event.button !== 0) return;
    void withCurrentWindow((appWindow) => appWindow.startDragging());
  }

  function minimizeWindow() {
    void withCurrentWindow((appWindow) => appWindow.minimize());
  }

  function toggleMaximizeWindow() {
    void withCurrentWindow(async (appWindow) => {
      await appWindow.toggleMaximize();
      isMaximized = await appWindow.isMaximized();
    });
  }

  function closeWindow() {
    void withCurrentWindow((appWindow) => appWindow.close());
  }

  onMount(() => {
    if (!isTauriWindow()) return;
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();
      isMaximized = await appWindow.isMaximized();
      unlistenResize = await appWindow.onResized(() => {
        void appWindow.isMaximized().then((maximized) => {
          if (!disposed) isMaximized = maximized;
        });
      });
      unlistenFocus = await appWindow.onFocusChanged(({ payload: focused }) => {
        if (focused) void appWindow.requestUserAttention(null);
      });
    })();

    return () => {
      disposed = true;
      unlistenResize?.();
      unlistenFocus?.();
    };
  });
</script>

<div class="topbar">
  <div class="topbar-navigation">
    <button
      type="button"
      class="toggle"
      aria-label="Toggle workspace rail"
      onclick={onToggleRail}
    >
      &#9776;
    </button>
    <button
      type="button"
      class="toggle"
      aria-label="Toggle session sidebar"
      onclick={onToggleSidebar}
    >
      &#9777;
    </button>
  </div>
  <span class="window-title">choux</span>
  <div class="topbar-content">{@render topBar?.()}</div>
  <div
    class="window-drag-region"
    aria-hidden="true"
    onmousedown={startWindowDrag}
  ></div>
  <div class="server-manager">
    <button
      type="button"
      class="toggle server-icon"
      aria-label="Server manager"
      onclick={() => (showServerPopover = !showServerPopover)}
    >
      &#9639;
      <span class="server-agg-dot" data-status={aggregateStatus}></span>
    </button>
    {#if showServerPopover}
      <ServerPopover
        onClose={() => (showServerPopover = false)}
        onManage={(focusServerId) => {
          showServerPopover = false;
          onManageServers(focusServerId);
        }}
      />
    {/if}
  </div>
  <button
      type="button"
      class="toggle"
      aria-label="Settings"
      aria-pressed={settingsOpen}
      onclick={onToggleSettings}
    >⚙</button>
  {#if isTauriWindow()}
    <div class="window-controls" aria-label="Window controls">
      <button type="button" class="window-control" aria-label="Minimize window" onclick={minimizeWindow}>−</button>
      <button
        type="button"
        class="window-control"
        aria-label={isMaximized ? "Restore window" : "Maximize window"}
        onclick={toggleMaximizeWindow}
      >{isMaximized ? "❐" : "□"}</button>
      <button type="button" class="window-control close" aria-label="Close window" onclick={closeWindow}>×</button>
    </div>
  {/if}
</div>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    padding: 0 0 0 var(--sp-2);
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    min-height: 38px;
    user-select: none;
  }

  .topbar-navigation {
    display: flex;
    align-items: center;
  }

  .window-title {
    color: var(--fg-dim);
    font-size: 0.75rem;
    padding-left: var(--sp-1);
  }

  .window-drag-region {
    align-self: stretch;
    flex: 1;
    min-width: var(--sp-3);
    cursor: default;
  }

  .toggle {
    background: none;
    border: none;
    color: var(--fg-dim);
    cursor: pointer;
    padding: var(--sp-1);
    font-size: 0.9rem;
    line-height: 1;
  }

  .toggle:hover {
    color: var(--fg);
  }

  .topbar-content {
    min-width: 0;
  }

  .window-controls {
    display: flex;
    align-self: stretch;
    margin-left: var(--sp-1);
  }

  .window-control {
    width: 42px;
    border: none;
    background: transparent;
    color: var(--fg-dim);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }

  .window-control:hover {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
    color: var(--fg);
  }

  .window-control.close:hover {
    background: var(--status-offline);
    color: #fff;
  }

  .window-control:focus-visible,
  .toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .server-manager {
    position: relative;
    flex-shrink: 0;
  }

  .server-icon {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .server-agg-dot {
    position: absolute;
    top: -1px;
    right: -1px;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    border: 1.5px solid var(--bg-elevated);
    background: var(--status-offline);
  }

  .server-agg-dot[data-status="online"] {
    background: var(--status-online);
  }

  .server-agg-dot[data-status="degraded"] {
    background: var(--status-warn);
  }
</style>
