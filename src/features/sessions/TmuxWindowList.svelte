<script lang="ts">
  import type { Session } from "@pty-server/protocol";
  import { useServerRegistry } from "../../registry/context";
  import { clientsFormat, parseTty, parseWindows, sessionNameForTty, windowDetail, windowsFormat, type TmuxWindow } from "./tmuxParse";

  interface Props {
    session: Session;
    serverId: string;
  }

  let { session, serverId }: Props = $props();

  const serverRegistry = useServerRegistry();
  const REFRESH_MS = 15_000;
  const EXEC_TIMEOUT_MS = 3000;

  let windows = $state<TmuxWindow[]>([]);
  let cachedTmuxSession: string | undefined;

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
    cachedTmuxSession ??= await resolveTmuxSession();
    if (cachedTmuxSession === undefined) return [];
    const listed = await listWindows(cachedTmuxSession);
    if (listed !== undefined) return listed;
    cachedTmuxSession = await resolveTmuxSession();
    return cachedTmuxSession === undefined ? [] : await listWindows(cachedTmuxSession) ?? [];
  }

  $effect(() => {
    if (!execEnabled) {
      windows = [];
      return;
    }
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const next = await loadWindows();
        if (!cancelled) windows = next;
      } catch {
        if (!cancelled) windows = [];
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
      <li class:active={window.active}>
        <span class="label">{window.index}: {window.name}</span>
        {#if detail}
          <span class="detail" title={detail}>{detail}</span>
        {/if}
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
    flex-direction: column;
    gap: 1px;
    padding: 2px 0 2px var(--sp-2);
    border-left: 2px solid var(--border);
    font-size: 0.8rem;
    color: var(--fg-dim);
  }

  li.active {
    border-left-color: var(--accent);
    color: var(--fg);
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
