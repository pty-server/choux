<script lang="ts">
  import type { Session } from "@pty-server/protocol";
  import { useServerRegistry } from "../../registry/context";
  import { agentStateKey } from "../../registry/agentStateKey";
  import type { AgentState } from "../../registry/types";
  import AgentStatusBadge from "./AgentStatusBadge.svelte";
  import { agentLabelFor } from "./agentDetect";
  import { clientsFormat, panesFormat, parsePanes, parseTty, parseWindows, sessionNameForTty, windowDetail, windowsFormat, type TmuxPane, type TmuxWindow } from "./tmuxParse";
  import { loadTmuxWindowListing } from "./tmuxWindows";

  interface Props {
    session: Session;
    serverId: string;
    onFocusSession: () => void;
  }

  let { session, serverId, onFocusSession }: Props = $props();

  const serverRegistry = useServerRegistry();
  const REFRESH_MS = 15_000;
  const EXEC_TIMEOUT_MS = 3000;

  let windows = $state<TmuxWindow[]>([]);
  let panes = $state<TmuxPane[]>([]);
  let tmuxSession: string | undefined;

  let agentStates = $derived(serverRegistry.get(serverId)?.agentStates ?? {});

  function panesIn(windowId: string): TmuxPane[] {
    return panes.filter((pane) => pane.windowId === windowId);
  }

  function agentStateIn(windowId: string): AgentState | undefined {
    for (const pane of panesIn(windowId)) {
      const state = agentStates[agentStateKey(session.id, pane.id)];
      if (state !== undefined) return state;
    }
    return undefined;
  }

  function agentNameIn(windowId: string): string | undefined {
    for (const pane of panesIn(windowId)) {
      const label = agentLabelFor(pane.command);
      if (label !== undefined) return label;
    }
    return undefined;
  }

  let execEnabled = $derived(
    serverRegistry.get(serverId)?.info?.capabilities?.includes("exec") === true,
  );

  async function stdoutOrUndefined(cmd: string, args: string[]): Promise<string | undefined> {
    const result = await serverRegistry.execSession(serverId, session.id, { cmd, args, timeoutMs: EXEC_TIMEOUT_MS });
    return result.code === 0 ? result.stdout : undefined;
  }

  async function resolveTmuxSession(): Promise<string | undefined> {
    const tty = parseTty(await stdoutOrUndefined("ps", ["-o", "tty=", "-p", String(session.pid)]) ?? "");
    if (tty === undefined) return undefined;
    const clients = await stdoutOrUndefined("tmux", ["list-clients", "-F", clientsFormat]);
    return clients === undefined ? undefined : sessionNameForTty(clients, tty);
  }

  async function listWindows(tmuxSession: string): Promise<TmuxWindow[] | undefined> {
    const listed = await stdoutOrUndefined("tmux", ["list-windows", "-t", tmuxSession, "-F", windowsFormat]);
    return listed === undefined ? undefined : parseWindows(listed);
  }

  async function loadWindows(): Promise<TmuxWindow[]> {
    const listing = await loadTmuxWindowListing(resolveTmuxSession, listWindows);
    tmuxSession = listing.session;
    return listing.windows;
  }

  async function loadPanes(): Promise<TmuxPane[]> {
    const listed = await stdoutOrUndefined("tmux", ["list-panes", "-a", "-F", panesFormat]);
    if (listed === undefined) return panes;
    const parsed = parsePanes(listed);
    serverRegistry.reconcileAgentPanes(serverId, parsed.map((pane) => pane.id));
    return parsed;
  }

  async function selectWindow(window: TmuxWindow): Promise<void> {
    onFocusSession();
    if (!execEnabled || tmuxSession === undefined) return;
    if (await stdoutOrUndefined("tmux", ["select-window", "-t", window.id]) === undefined) return;
    const listed = await listWindows(tmuxSession);
    if (listed !== undefined) windows = listed;
  }

  $effect(() => {
    if (!execEnabled) {
      windows = [];
      panes = [];
      return;
    }
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const next = await loadWindows();
        const nextPanes = await loadPanes();
        if (cancelled) return;
        windows = next;
        panes = nextPanes;
      } catch {
        if (!cancelled) {
          windows = [];
          panes = [];
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  });
</script>

{#if windows.length > 0}
  <ul class="windows">
    {#each windows as window (window.id)}
      {@const detail = windowDetail(window)}
      {@const state = agentStateIn(window.id)}
      {@const agent = agentNameIn(window.id) ?? state?.agent}
      <li class:active={window.active}>
        <button type="button" class="window" onclick={() => void selectWindow(window)}>
          <span class="heading">
            <span class="label">{window.index}: {window.name}</span>
            <AgentStatusBadge {agent} {state} />
          </span>
          {#if detail}
            <span class="detail" title={detail}>{detail}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .windows {
    display: flex;
    flex-direction: column;
    padding: 0 var(--sp-2) var(--sp-2) var(--sp-2);
  }

  li {
    display: flex;
    min-width: 0;
    border-left: 2px solid var(--border);
  }

  li.active {
    border-left-color: var(--accent);
  }

  .window {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    align-items: stretch;
    gap: 1px;
    padding: 2px 0 2px var(--sp-2);
    border: none;
    background: none;
    font: inherit;
    font-size: 0.8rem;
    color: var(--fg-dim);
    text-align: left;
    cursor: pointer;
  }

  li.active .window {
    color: var(--fg);
  }

  .window:hover {
    background: var(--bg-elevated);
  }

  .window:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .heading {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: var(--sp-2);
  }

  .label,
  .detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail {
    font-size: 0.75rem;
    color: var(--fg-dim);
    opacity: 0.8;
  }
</style>
