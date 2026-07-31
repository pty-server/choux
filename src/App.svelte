<script lang="ts">
  import { PROTOCOL_VERSION, type DirectoryListing, type Session } from "@pty-server/protocol";
  import { createApiClient, describeConnectionFailure } from "./kernel/transport/api";
  import { createServerRegistry } from "./kernel/servers/serverRegistry.svelte";
  import Shell from "./kernel/ui/Shell.svelte";
  import AttachPane from "./kernel/ui/AttachPane.svelte";
  import NewSessionDialog from "./features/sessions/NewSessionDialog.svelte";
  import RenameSessionDialog from "./features/sessions/RenameSessionDialog.svelte";
  import AddWorkspaceDialog from "./features/sessions/AddWorkspaceDialog.svelte";
  import { measureViewport } from "./kernel/ui/viewport";
  import { tokenStore } from "./kernel/storage/serverConfigStore";
  import { serverUsesToken } from "./kernel/storage/serverConfigStore";
  import { initializeTokenStore } from "./kernel/storage/tokenStore";
  import { getLocalServerBridge, localServerEndpoint, type LocalServerTool } from "./kernel/platform/localServer";
  import { listenForSessionDeepLinks, type SessionDeepLink } from "./kernel/platform/deepLink";
  import { provideServerRegistry } from "./registry/context";
  import LocalServerDialog from "./features/servers/LocalServerDialog.svelte";
  import SettingsPage from "./features/settings/SettingsPage.svelte";
  import { getTerminalSettings, saveTerminalSettings } from "./kernel/storage/terminalThemeStore";
  import { getGlobalShortcutSettings, saveGlobalShortcutSettings } from "./kernel/storage/globalShortcutStore";
  import { applyGlobalShortcut, globalShortcutSupported } from "./kernel/platform/globalShortcut";
  import { defaultGlobalShortcutSettings, type GlobalShortcutSettings } from "./registry/globalShortcut";
  import { getEventSettings, saveEventSettings } from "./kernel/storage/eventSettingsStore";
  import { defaultEventSettings, type EventSettings } from "./registry/eventSettings";
  import { revealAndFocusCurrentWindow } from "./kernel/platform/windowAttention";
  import type { AttentionTarget } from "./kernel/servers/serverRegistry.svelte";
  import { getKeybindingOverrides, saveKeybindingOverrides } from "./kernel/storage/keybindingStore";
  import { isMacPlatform } from "./kernel/extensibility/keydispatch";
  import { keybindingsByAccelerator, resolveKeybindings, type KeybindingOverrides } from "./registry/keybindings";
  import { getSessionProfiles, saveSessionProfiles } from "./kernel/storage/sessionProfileStore";
  import { randomId } from "./kernel/storage/db";
  import {
    cloneSessionProfiles,
    defaultSessionProfiles,
    findSessionProfile,
    normalizeSessionProfiles,
    profileLaunchInput,
    resolveDefaultProfile,
    type SessionProfiles,
  } from "./registry/sessionProfiles";
  import { getLastOpenSession, saveLastOpenSession } from "./kernel/storage/lastSessionStore";
  import { defaultTerminalSettings, type TerminalSettings } from "./registry/terminalTheme";
  import { onMount } from "svelte";

  const registry = createServerRegistry({
    questionsEnabled: () => eventSettings.handleQuestions,
    onAttention: (target) => void followAttention(target),
  });
  provideServerRegistry(registry);

  let defaultServerId = $derived(registry.defaultServerId);
  let conn = $derived(selectedServerId ? registry.get(selectedServerId) : undefined);
  let workspaces = $derived(conn?.workspaces ?? []);
  let sessions = $derived(conn?.sessions ?? []);
  let terminalTitles = $derived(conn?.terminalTitles ?? {});
  let focusedSessionWorkspaceId = $derived(sessions.find((session) => session.id === focusedSessionId)?.workspaceId ?? selectedWorkspaceId);
  let serverInfo = $derived(conn?.info);
  let tokenStorageError = $derived(conn?.storageError);
  let resolvedToken = $state<string | undefined>(undefined);
  let hasServers = $derived(registry.servers.length > 0);
  type ErrorSource = "initialization" | "token" | "last-session" | "session-create" | "session-remove" | "deep-link" | "local-discovery";

  let error = $state("");
  let errorSource = $state<ErrorSource | undefined>(undefined);
  let focusedSessionId = $state<string | undefined>(undefined);
  let focusedDims = $state<{ cols: number; rows: number } | undefined>(undefined);
  let focusedConnectionState = $state<"attaching" | "online" | "reconnecting" | "offline" | "exited" | undefined>(undefined);
  let attachProtocolMismatch = $state<number | undefined>(undefined);
  let selectedServerId = $state<string | undefined>(undefined);
  let selectedWorkspaceId = $state<string | undefined>(undefined);
  let showNewSessionDialog = $state(false);
  let sessionToRename = $state<Session | undefined>(undefined);
  let showAddWorkspaceDialog = $state(false);
  let addWorkspaceError = $state("");
  let showLocalServerDialog = $state(false);
  let localServerBusy = $state(false);
  let localServerMessage = $state("");
  let localServerTool = $state<LocalServerTool>({ available: false, npmAvailable: false });
  let settingsOpen = $state(false);
  let terminalSettings = $state<TerminalSettings>({
    ...defaultTerminalSettings,
    theme: { ...defaultTerminalSettings.theme },
  });
  let globalShortcut = $state<GlobalShortcutSettings>({ ...defaultGlobalShortcutSettings });
  let eventSettings = $state<EventSettings>({ ...defaultEventSettings });
  let keybindingOverrides = $state<KeybindingOverrides>({});
  let sessionProfiles = $state<SessionProfiles>(cloneSessionProfiles(defaultSessionProfiles));
  let resolvedKeybindings = $derived(resolveKeybindings(keybindingOverrides, isMacPlatform()));
  let restoredLastSession = $state(false);
  let layoutRevision = $state(0);

  let mainContainer: HTMLDivElement | undefined = $state(undefined);

  function showError(message: string, source: ErrorSource) {
    error = message;
    errorSource = source;
  }

  function clearError(source: ErrorSource | undefined = undefined) {
    if (source !== undefined && errorSource !== source) return;
    error = "";
    errorSource = undefined;
  }

  onMount(() => {
    let disposed = false;
    let unlisten = () => {};

    void (async () => {
      try {
        await initializeTokenStore();
        terminalSettings = await getTerminalSettings();
        globalShortcut = await getGlobalShortcutSettings();
        if (globalShortcut.enabled) void applyGlobalShortcut(globalShortcut);
        eventSettings = await getEventSettings();
        keybindingOverrides = await getKeybindingOverrides();
        sessionProfiles = await getSessionProfiles();
        await registry.load();
        await discoverLocalServers();
        const lastSession = await getLastOpenSession();
        if (!disposed && lastSession && registry.get(lastSession.serverId)) {
          selectedServerId = lastSession.serverId;
          selectedWorkspaceId = lastSession.workspaceId;
          focusedSessionId = lastSession.sessionId;
        }
        restoredLastSession = true;
        if (!disposed) unlisten = await listenForSessionDeepLinks(handleSessionDeepLink);
      } catch (err) {
        showError(err instanceof Error ? err.message : "Unable to initialize native token storage.", "initialization");
      }
    })();

    return () => {
      disposed = true;
      unlisten();
    };
  });

  $effect(() => {
    const config = conn?.config;
    if (!config) {
      resolvedToken = undefined;
      clearError("token");
      return;
    }
    let cancelled = false;
    if (!serverUsesToken(config)) {
      resolvedToken = undefined;
      clearError("token");
      return;
    }
    tokenStore.get(config.tokenRef).then((token) => {
      if (!cancelled) {
        resolvedToken = token;
        clearError("token");
      }
    }).catch((err) => {
      if (!cancelled) showError(err instanceof Error ? err.message : "Native token storage is unavailable.", "token");
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (selectedServerId === undefined && defaultServerId !== undefined) {
      selectedServerId = defaultServerId;
    }
  });

  $effect(() => {
    if (workspaces.length > 0 && selectedWorkspaceId === undefined) {
      selectedWorkspaceId = workspaces[0].id;
    }
  });

  $effect(() => {
    void focusedSessionId;
    focusedDims = undefined;
    focusedConnectionState = undefined;
    attachProtocolMismatch = undefined;
  });

  $effect(() => {
    if (!restoredLastSession || !selectedServerId || !focusedSessionId) return;
    void saveLastOpenSession({
      serverId: selectedServerId,
      sessionId: focusedSessionId,
      ...(focusedSessionWorkspaceId ? { workspaceId: focusedSessionWorkspaceId } : {}),
    }).catch((err) => {
      showError(err instanceof Error ? err.message : "Unable to save the last open session.", "last-session");
    });
  });

  $effect(() => {
    if (tokenStorageError) showError(tokenStorageError, "token");
    else clearError("token");
  });

  function handleCreate(input: {
    workspaceId?: string;
    cmd?: string;
    args?: string[];
    env?: Record<string, string>;
    name?: string;
    serverId: string;
  }) {
    const targetConn = registry.get(input.serverId);
    if (!targetConn || !mainContainer) return;
    const { cols, rows } = measureViewport(mainContainer);
    getServerToken(targetConn.config).then((token) => {
      if (serverUsesToken(targetConn.config) && !token) {
        showError("No saved token for the selected server.", "session-create");
        return undefined;
      }
      return apiFor(targetConn.config, token).createSession({
        workspaceId: input.workspaceId,
        cmd: input.cmd,
        args: input.args,
        env: input.env,
        cols,
        rows,
        name: input.name,
      }).then((session) => {
        focusSession(input.serverId, session.id, session.workspaceId);
        showNewSessionDialog = false;
        clearError("session-create");
        registry.refresh(input.serverId);
      });
    }).catch((err) => {
      showError(err instanceof Error ? err.message : String(err), "session-create");
    });
  }

  function handleStartDefaultSession(serverId = selectedServerId, workspaceId = selectedWorkspaceId) {
    if (!serverId) return;
    // No default profile means no cmd at all, so the server picks its default shell.
    const profile = resolveDefaultProfile(sessionProfiles);
    handleCreate({ workspaceId, serverId, ...(profile ? profileLaunchInput(profile) : {}) });
  }

  function handleLaunchProfile(profileId: string) {
    if (!selectedServerId) return;
    const profile = findSessionProfile(sessionProfiles, profileId);
    if (!profile) return;
    handleCreate({ workspaceId: selectedWorkspaceId, serverId: selectedServerId, ...profileLaunchInput(profile) });
  }

  async function handleRenameSession(sessionId: string, name: string): Promise<void> {
    if (!selectedServerId) throw new Error("No server selected.");
    const targetConn = registry.get(selectedServerId);
    if (!targetConn) throw new Error("Selected server is unavailable.");
    const token = await getServerToken(targetConn.config);
    if (serverUsesToken(targetConn.config) && !token) throw new Error("No saved token for the selected server.");
    await apiFor(targetConn.config, token).updateSession(sessionId, name);
    registry.refresh(selectedServerId);
  }

  async function handleRemoveSession(session: Session): Promise<void> {
    const serverId = selectedServerId;
    if (!serverId) return;
    const targetConn = registry.get(serverId);
    if (!targetConn) return;
    try {
      const token = await getServerToken(targetConn.config);
      if (serverUsesToken(targetConn.config) && !token) throw new Error("No saved token for the selected server.");
      await apiFor(targetConn.config, token).deleteSession(session.id);
      if (focusedSessionId === session.id) focusedSessionId = undefined;
      registry.refresh(serverId);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err), "session-remove");
    }
  }

  function openAddWorkspaceDialog() {
    addWorkspaceError = "";
    showAddWorkspaceDialog = true;
  }

  function handleFocusedDims(dims: { cols: number; rows: number }) {
    focusedDims = dims;
  }

  function handleFocusedConnectionState(state: "attaching" | "online" | "reconnecting" | "offline" | "exited") {
    focusedConnectionState = state;
    if (state === "exited" && selectedServerId) registry.refresh(selectedServerId);
  }

  function handleAttachProtocolMismatch(serverProtocol: number) {
    attachProtocolMismatch = serverProtocol;
  }

  function handleSessionDeepLink(link: SessionDeepLink) {
    // A link may carry either the stable /v1/info identity or this install's
    // local config id, which is a per-install UUID.
    const target = registry.servers.find((server) => server.config.serverId === link.serverId)
      ?? registry.get(link.serverId);
    if (!target) {
      showError("This link refers to a server that is not configured in Choux.", "deep-link");
      return;
    }
    focusSession(target.config.id, link.sessionId, undefined);
  }

  function focusSession(serverId: string, sessionId: string, workspaceId: string | undefined) {
    selectedServerId = serverId;
    selectedWorkspaceId = workspaceId;
    focusedSessionId = sessionId;
  }

  async function followAttention(target: AttentionTarget) {
    if (eventSettings.revealWindow) await revealAndFocusCurrentWindow();
    if (!eventSettings.followAttention) return;
    const targetConn = registry.get(target.serverId);
    focusSession(target.serverId, target.sessionId, targetConn?.sessions.find((session) => session.id === target.sessionId)?.workspaceId);
    if (target.pane === undefined || targetConn?.info?.capabilities?.includes("exec") !== true) return;
    await registry.execSession(target.serverId, target.sessionId, {
      cmd: "tmux",
      args: ["select-window", "-t", target.pane, ";", "select-pane", "-t", target.pane],
      timeoutMs: 3000,
    }).catch(() => {});
  }

  async function handleAddWorkspace(path: string, serverId: string) {
    const targetConn = registry.get(serverId);
    if (!targetConn) return;
    try {
      const token = await getServerToken(targetConn.config);
      if (serverUsesToken(targetConn.config) && !token) {
        addWorkspaceError = "No saved token for the selected server.";
        return;
      }
      const workspace = await apiFor(targetConn.config, token).createWorkspace(path);
      selectedServerId = serverId;
      selectedWorkspaceId = workspace.id;
      showAddWorkspaceDialog = false;
      addWorkspaceError = "";
      registry.refresh(serverId);
    } catch (err) {
      addWorkspaceError = err instanceof Error ? err.message : String(err);
    }
  }

  async function browseDirectories(
    serverId: string,
    path: string | undefined = undefined,
    q: string | undefined = undefined,
    cursor: string | undefined = undefined,
  ): Promise<DirectoryListing> {
    const targetConn = registry.get(serverId);
    if (!targetConn) throw new Error("Selected server is unavailable.");
    const token = await getServerToken(targetConn.config);
    if (serverUsesToken(targetConn.config) && !token) throw new Error("No saved token for the selected server.");
    return apiFor(targetConn.config, token).listDirectories(path, q, cursor);
  }

  function apiFor(config: import("./kernel/storage/serverConfigStore").ServerConfig, token: string | undefined) {
    return createApiClient({ baseUrl: config.url, token, ...(config.transport === "local" && config.instance ? { localInstance: config.instance } : {}) });
  }

  async function getServerToken(config: import("./kernel/storage/serverConfigStore").ServerConfig): Promise<string | undefined> {
    if (!serverUsesToken(config)) return undefined;
    return tokenStore.get(config.tokenRef);
  }

  async function discoverLocalServers(): Promise<string[]> {
    const bridge = await getLocalServerBridge();
    if (!bridge) return [];
    localServerTool = await bridge.tool();
    const candidates = await bridge.candidates();
    if (candidates.length === 0) {
      showLocalServerDialog = true;
      return [];
    }

    const connectedServerIds: string[] = [];
    for (const candidate of candidates) {
      const url = localServerEndpoint(candidate.instance);
      try {
        const info = await createApiClient({ baseUrl: url, localInstance: candidate.instance }).getInfo();
        const connection = await registry.ensureServer({
          url,
          transport: "local",
          instance: candidate.instance,
          label: `Local ${candidate.instance}`,
          auth: "none",
          serverId: info.serverId,
        });
        connectedServerIds.push(connection.config.id);
      } catch (err) {
        localServerMessage = `Could not connect to local ptys instance ${candidate.instance}. ${describeConnectionFailure(err)}`;
      }
    }
    if (connectedServerIds.length > 0) {
      showLocalServerDialog = false;
      localServerMessage = "";
      // Local discovery also mirrors its failure into the app-wide alert.
      // Clear only that alert on recovery, leaving unrelated errors visible.
      clearError("local-discovery");
      return connectedServerIds;
    }
    if (localServerMessage) {
      showError(localServerMessage, "local-discovery");
    }
    return [];
  }

  async function retryLocalServers(): Promise<void> {
    localServerBusy = true;
    localServerMessage = "";
    try { await discoverLocalServers(); } catch (err) { localServerMessage = err instanceof Error ? err.message : String(err); }
    finally { localServerBusy = false; }
  }

  async function installLocalServer(): Promise<void> {
    const bridge = await getLocalServerBridge();
    if (!bridge) return;
    localServerBusy = true;
    localServerMessage = "";
    try {
      const result = await bridge.install();
      if (!result.ok) localServerMessage = result.message ?? "npm could not install ptys.";
      else await discoverLocalServers();
    } catch (err) { localServerMessage = err instanceof Error ? err.message : String(err); }
    finally { localServerTool = await bridge.tool(); localServerBusy = false; }
  }

  async function startLocalServer(): Promise<void> {
    const bridge = await getLocalServerBridge();
    if (!bridge) return;
    localServerBusy = true;
    localServerMessage = "";
    try {
      const knownInstances = new Set((await bridge.candidates()).map((candidate) => candidate.instance));
      const result = await bridge.start();
      if (!result.ok) { localServerMessage = result.message ?? "ptys could not start the local daemon."; return; }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const connectedServerIds = await discoverLocalServers();
        const startedServerId = connectedServerIds.find((id) => {
          const config = registry.get(id)?.config;
          return config?.transport === "local" && config.instance !== undefined && !knownInstances.has(config.instance);
        });
        if (startedServerId) {
          handleStartDefaultSession(startedServerId, undefined);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      localServerMessage = "ptys started, but Choux could not connect yet. Retry in a moment.";
    } catch (err) { localServerMessage = err instanceof Error ? err.message : String(err); }
    finally { localServerBusy = false; }
  }

  async function handleSaveTerminalSettings(settings: TerminalSettings): Promise<void> {
    await saveTerminalSettings(settings);
    terminalSettings = { ...settings, theme: { ...settings.theme } };
  }

  async function handleSaveGlobalShortcut(settings: GlobalShortcutSettings): Promise<string | undefined> {
    const failure = await applyGlobalShortcut(settings);
    if (failure) return failure;
    await saveGlobalShortcutSettings(settings);
    globalShortcut = { ...settings };
    return undefined;
  }

  async function handleSaveEventSettings(settings: EventSettings): Promise<void> {
    await saveEventSettings(settings);
    eventSettings = { ...settings };
  }

  async function handleSaveKeybindings(overrides: KeybindingOverrides): Promise<void> {
    await saveKeybindingOverrides(overrides);
    keybindingOverrides = { ...overrides };
  }

  async function handleSaveSessionProfiles(profiles: SessionProfiles): Promise<void> {
    await saveSessionProfiles(profiles);
    sessionProfiles = normalizeSessionProfiles(profiles);
  }
</script>

<main>
  <Shell
    {workspaces}
    {sessions}
    {selectedServerId}
    {selectedWorkspaceId}
    {focusedSessionId}
    {focusedDims}
    {terminalTitles}
    {focusedConnectionState}
    clientProtocolVersion={PROTOCOL_VERSION}
    serverProtocolVersion={attachProtocolMismatch ?? serverInfo?.protocol}
    onSelectWorkspace={(serverId, workspaceId) => {
      if (selectedServerId !== serverId) focusedSessionId = undefined;
      selectedServerId = serverId;
      selectedWorkspaceId = workspaceId;
    }}
    onSelectSession={(session) => {
      selectedWorkspaceId = session.workspaceId;
      focusedSessionId = session.id;
    }}
    onRenameSession={(session) => sessionToRename = session}
    onRemoveSession={(session) => void handleRemoveSession(session)}
    onStartDefaultSession={handleStartDefaultSession}
    onNewSession={() => showNewSessionDialog = true}
    onAddWorkspace={openAddWorkspaceDialog}
    sessionProfiles={sessionProfiles.profiles}
    onLaunchProfile={handleLaunchProfile}
    {settingsOpen}
    onToggleSettings={() => settingsOpen = !settingsOpen}
    onLayoutChange={() => layoutRevision += 1}
    keybindings={keybindingsByAccelerator(resolvedKeybindings)}
  >
    {#snippet pane()}
      {#if settingsOpen}
        <SettingsPage
          settings={terminalSettings}
          onSave={handleSaveTerminalSettings}
          onClose={() => settingsOpen = false}
          {globalShortcut}
          globalShortcutSupported={globalShortcutSupported()}
          onSaveGlobalShortcut={handleSaveGlobalShortcut}
          {eventSettings}
          onSaveEventSettings={handleSaveEventSettings}
          {keybindingOverrides}
          isMac={isMacPlatform()}
          onSaveKeybindings={handleSaveKeybindings}
          {sessionProfiles}
          onSaveSessionProfiles={handleSaveSessionProfiles}
          newProfileId={randomId}
        />
      {:else}
        <div class="attach-container" bind:this={mainContainer}>
          {#if focusedSessionId && conn && (resolvedToken || !serverUsesToken(conn.config))}
            {#key focusedSessionId}
              <AttachPane
                baseUrl={conn.config.url}
                localInstance={conn.config.transport === "local" ? conn.config.instance : undefined}
                token={resolvedToken}
                sessionId={focusedSessionId}
                serverId={conn.config.id}
                theme={terminalSettings.theme}
                fontSize={terminalSettings.fontSize}
                {layoutRevision}
                onDims={handleFocusedDims}
                onConnectionState={handleFocusedConnectionState}
                onProtocolMismatch={handleAttachProtocolMismatch}
              />
            {/key}
          {:else if !hasServers}
            <div class="empty-pane">No servers configured. Open the server manager (top-right) to add one.</div>
          {:else}
            <div class="empty-pane">Select a session</div>
          {/if}
        </div>
      {/if}
    {/snippet}
  </Shell>
  {#if error}
    <div class="error" role="alert">
      <span>{error}</span>
      <button type="button" aria-label="Dismiss error" onclick={() => clearError()}>×</button>
    </div>
  {/if}
  <NewSessionDialog
    open={showNewSessionDialog}
    workspaceId={selectedWorkspaceId}
    serverId={selectedServerId}
    onClose={() => showNewSessionDialog = false}
    onCreate={handleCreate}
    profiles={sessionProfiles.profiles}
  />
  <RenameSessionDialog
    open={sessionToRename !== undefined}
    session={sessionToRename}
    onRename={handleRenameSession}
    onClose={() => sessionToRename = undefined}
  />
  <AddWorkspaceDialog
    open={showAddWorkspaceDialog}
    onCreate={handleAddWorkspace}
    onBrowse={browseDirectories}
    onClose={() => showAddWorkspaceDialog = false}
    error={addWorkspaceError}
  />
  <LocalServerDialog
    open={showLocalServerDialog}
    toolAvailable={localServerTool.available}
    npmAvailable={localServerTool.npmAvailable}
    busy={localServerBusy}
    message={localServerMessage || localServerTool.message}
    onInstall={() => void installLocalServer()}
    onStart={() => void startLocalServer()}
    onRetry={() => void retryLocalServers()}
    onClose={() => showLocalServerDialog = false}
  />
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    color: #e05252;
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
  }

  .error button {
    flex: none;
    border: 0;
    padding: 0 var(--sp-1);
    color: inherit;
    background: transparent;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
  }

  .error button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .attach-container {
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .empty-pane {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--fg-dim);
    font-size: 0.9rem;
  }
</style>
