<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { Session, Workspace } from "@pty-server/protocol";
  import CommandPalette from "../../features/palette/CommandPalette.svelte";
  import { createKernelRegistry } from "../extensibility/registry.svelte";
  import { provideKernelRegistry, useKernelRegistry, useServerRegistry } from "../../registry/context";
  import { dispatchReservedKeydown } from "../extensibility/keydispatch";
  import type { SessionProfile } from "../../registry/sessionProfiles";
  import { protocolMismatch } from "../transport/protocolVersion";
  import { buildRailModel } from "./railModel";
  import { accentPalette } from "../storage/serverConfigStore";
  import { clampSidebarWidth, defaultSidebarWidth, getSidebarWidth, saveSidebarWidth } from "../storage/sidebarWidthStore";
  import { getSessionOrder, orderSessions, reorderSessionIds, saveSessionOrder, sessionOrderScope, type SessionOrder } from "../storage/sessionOrderStore";
  import type { SessionDropPosition } from "../../registry/types";
  import { agentStateKey } from "../../registry/agentStateKey";
  import ShellTopBar from "./ShellTopBar.svelte";
  import ShellRail from "./ShellRail.svelte";
  import ShellSidebar from "./ShellSidebar.svelte";
  import ShellStatusBar from "./ShellStatusBar.svelte";
  import ManageServersDialog from "../../features/servers/ManageServersDialog.svelte";
  import QuestionDialog from "../../features/events/QuestionDialog.svelte";
  import { sessionViews } from "../../features/sessions/sessionViews";

  interface Props {
    workspaces: Workspace[];
    sessions: Session[];
    selectedServerId: string | undefined;
    selectedWorkspaceId: string | undefined;
    focusedSessionId: string | undefined;
    focusedDims?: { cols: number; rows: number };
    terminalTitles?: Readonly<Record<string, string>>;
    focusedConnectionState?: "attaching" | "online" | "reconnecting" | "offline" | "exited";
    clientProtocolVersion?: number;
    serverProtocolVersion?: number;
    onSelectWorkspace: (serverId: string, workspaceId: string) => void;
    onSelectSession: (session: Session) => void;
    onRenameSession: (session: Session) => void;
    onRemoveSession?: (session: Session) => void;
    onStartDefaultSession: () => void;
    onNewSession: () => void;
    onAddWorkspace: () => void;
    sessionProfiles?: SessionProfile[];
    onLaunchProfile?: (profileId: string) => void;
    settingsOpen: boolean;
    onToggleSettings: () => void;
    onLayoutChange?: () => void;
    /** accelerator -> commandId */
    keybindings?: Readonly<Record<string, string>>;
    topBar?: Snippet;
    pane?: Snippet;
  }

  let {
    workspaces,
    sessions,
    selectedServerId,
    selectedWorkspaceId,
    focusedSessionId,
    focusedDims,
    terminalTitles = {},
    focusedConnectionState,
    clientProtocolVersion,
    serverProtocolVersion,
    onSelectWorkspace,
    onSelectSession,
    onRenameSession,
    onRemoveSession,
    onStartDefaultSession,
    onNewSession,
    onAddWorkspace,
    sessionProfiles = [],
    onLaunchProfile,
    settingsOpen,
    onToggleSettings,
    onLayoutChange,
    keybindings = {},
    topBar,
    pane,
  }: Props = $props();

  // Default open on desktop (three-column layout) but closed on narrow
  // viewports, where the rail/sidebar render as off-canvas drawers over the
  // main pane - starting them open there would cover the just-loaded,
  // single-focused-pane baseline (CLIENT.md 12.6) with two drawers. Checked
  // once at mount; not re-evaluated on resize/rotate, matching the toggles
  // being the only way to open/close afterwards.
  const isNarrowViewport = typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
  let railCollapsed = $state(isNarrowViewport);
  let sidebarCollapsed = $state(isNarrowViewport);
  let sidebarWidth = $state(defaultSidebarWidth);
  let sessionOrder = $state<SessionOrder>({});

  $effect(() => {
    let cancelled = false;
    void getSidebarWidth().then((width) => {
      if (!cancelled) sidebarWidth = width;
    }).catch(() => {});
    return () => { cancelled = true; };
  });

  $effect(() => {
    let cancelled = false;
    void getSessionOrder().then((order) => {
      if (!cancelled) sessionOrder = order;
    }).catch(() => {});
    return () => { cancelled = true; };
  });

  async function commitSidebarWidth() {
    await tick();
    onLayoutChange?.();
    void saveSidebarWidth(sidebarWidth).catch(() => {});
  }

  let showManageServers = $state(false);
  let manageFocusServerId = $state<string | undefined>(undefined);

  function openManageServers(focusServerId: string | undefined = undefined) {
    manageFocusServerId = focusServerId;
    showManageServers = true;
  }

  provideKernelRegistry(createKernelRegistry());
  const registry = useKernelRegistry();
  const serverRegistry = useServerRegistry();

  for (const view of sessionViews) registry.registerSessionView(view);

  let railModel = $derived(buildRailModel(serverRegistry.servers));

  async function toggleRail() {
    railCollapsed = !railCollapsed;
    await tick();
    onLayoutChange?.();
  }

  registry.registerCommand({ id: "sidebar.toggle", title: "Toggle sidebar", run: () => { sidebarCollapsed = !sidebarCollapsed; } });
  registry.registerCommand({ id: "rail.toggle", title: "Toggle rail", run: () => { void toggleRail(); } });
  registry.registerCommand({ id: "settings.open", title: "Open settings", run: () => { if (!settingsOpen) onToggleSettings(); } });

  $effect(() => {
    function handleKeydown(event: KeyboardEvent) {
      dispatchReservedKeydown(event, registry, keybindings);
    }
    window.addEventListener("keydown", handleKeydown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeydown, { capture: true });
  });

  let selectedWorkspace = $derived(workspaces.find((w) => w.id === selectedWorkspaceId));

  let sortedSessions = $derived(
    [...sessions.filter((s) => s.workspaceId === selectedWorkspaceId)].sort((a, b) => {
      const ka = a.exited?.at ?? a.createdAt;
      const kb = b.exited?.at ?? b.createdAt;
      return kb - ka;
    }),
  );
  let orderScope = $derived(
    selectedServerId && selectedWorkspaceId ? sessionOrderScope(selectedServerId, selectedWorkspaceId) : undefined,
  );
  let mainSessions = $derived(orderSessions(
    sortedSessions.filter((session) => session.exited === undefined),
    orderScope ? sessionOrder[orderScope] : undefined,
  ));
  let foldedSessions = $derived(sortedSessions.filter((session) => session.exited !== undefined));

  function reorderSession(movedSessionId: string, targetSessionId: string, position: SessionDropPosition): void {
    if (orderScope === undefined) return;
    const ids = reorderSessionIds(mainSessions.map((session) => session.id), movedSessionId, targetSessionId, position);
    sessionOrder = { ...sessionOrder, [orderScope]: ids };
    void saveSessionOrder(sessionOrder).catch(() => {});
  }

  let focusedSession = $derived(
    focusedSessionId ? sessions.find((s) => s.id === focusedSessionId) : undefined,
  );
  let focusedTerminalTitle = $derived(focusedSessionId ? terminalTitles[focusedSessionId] : undefined);
  let focusedServerConfig = $derived(selectedServerId ? serverRegistry.get(selectedServerId)?.config : undefined);
  let hasProtocolMismatch = $derived(
    clientProtocolVersion !== undefined
    && serverProtocolVersion !== undefined
    && protocolMismatch(clientProtocolVersion, serverProtocolVersion),
  );
  let activeQuestion = $derived(serverRegistry.pendingQuestions[0]);

</script>

{#snippet sessionExtra(session: Session)}
  {@const view = registry.resolveSessionView({
    session,
    terminalTitle: terminalTitles[session.id],
    agentState: selectedServerId ? serverRegistry.get(selectedServerId)?.agentStates[agentStateKey(session.id, undefined)] : undefined,
  })}
  {#if view && selectedServerId}
    <view.component {session} serverId={selectedServerId} onFocusSession={() => onSelectSession(session)} />
  {/if}
{/snippet}

<div class="shell">
  <CommandPalette
    {sessions}
    {workspaces}
    {selectedServerId}
    onSelectSession={onSelectSession}
    onSelectWorkspace={(workspaceId) => {
      if (selectedServerId) onSelectWorkspace(selectedServerId, workspaceId);
    }}
    onNewSession={onNewSession}
    onAddWorkspace={onAddWorkspace}
    {sessionProfiles}
    {onLaunchProfile}
  />

  <ShellTopBar
    aggregateStatus={serverRegistry.aggregateStatus}
    {settingsOpen}
    {onToggleSettings}
    onToggleRail={() => void toggleRail()}
    onToggleSidebar={() => (sidebarCollapsed = !sidebarCollapsed)}
    onManageServers={openManageServers}
    {topBar}
  />

  <div class="body">
    {#if !railCollapsed}
      <ShellRail
        {railModel}
        {selectedServerId}
        {selectedWorkspaceId}
        railItems={registry.railItems}
        {onSelectWorkspace}
        {onAddWorkspace}
        onClose={() => void toggleRail()}
      />
    {/if}

    {#if !sidebarCollapsed}
      <ShellSidebar
        {selectedWorkspace}
        {mainSessions}
        {foldedSessions}
        {terminalTitles}
        {focusedSessionId}
        sidebarItems={registry.sidebarItems}
        sessionExtra={selectedServerId ? sessionExtra : undefined}
        width={sidebarWidth}
        onResize={(next) => (sidebarWidth = clampSidebarWidth(next))}
        onResizeEnd={() => void commitSidebarWidth()}
        {onSelectSession}
        {onRenameSession}
        {onRemoveSession}
        onReorderSession={reorderSession}
        {onStartDefaultSession}
        {onNewSession}
        onClose={() => (sidebarCollapsed = true)}
      />
    {/if}

    <div class="main">{@render pane?.()}</div>
  </div>

  <ShellStatusBar
    {focusedSession}
    {focusedTerminalTitle}
    {focusedServerConfig}
    {focusedDims}
    {focusedConnectionState}
    {hasProtocolMismatch}
    {clientProtocolVersion}
    {serverProtocolVersion}
    statusItems={registry.statusItems}
  />

  <ManageServersDialog
    open={showManageServers}
    accentPalette={accentPalette}
    clientProtocolVersion={clientProtocolVersion}
    focusServerId={manageFocusServerId}
    onClose={() => { showManageServers = false; manageFocusServerId = undefined; }}
  />
  <QuestionDialog
    question={activeQuestion}
    queued={serverRegistry.pendingQuestions.length - 1}
    onRespond={(id, response) => serverRegistry.answerQuestion(id, response)}
  />
</div>

<style>
  .shell {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
    font-family: var(--font-ui);
  }

  .body {
    display: flex;
    overflow: hidden;
    min-height: 0;
  }

  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  @media (max-width: 640px) {
    .main {
      width: 100vw;
      height: 100vh;
    }
  }
</style>
