<script lang="ts">
  import type { Session, Workspace } from "@pty-server/protocol";
  import { useKernelRegistry, useServerRegistry } from "../../registry/context";

  interface Props {
    sessions: Session[];
    workspaces: Workspace[];
    selectedServerId: string | undefined;
    onSelectSession: (session: Session) => void;
    onSelectWorkspace: (workspaceId: string) => void;
    onNewSession: () => void;
    onAddWorkspace: () => void;
  }

  let { sessions, selectedServerId, onSelectSession, onSelectWorkspace, onNewSession, onAddWorkspace }: Props = $props();

  const registry = useKernelRegistry();
  const serverRegistry = useServerRegistry();
  let serverConfig = $derived(selectedServerId ? serverRegistry.get(selectedServerId)?.config : undefined);

  let open = $state(false);
  let query = $state("");
  let selectedIndex = $state(0);
  let inputRef: HTMLInputElement | undefined = $state();

  // Registration calls have no reactive deps, so this effect body only
  // runs once at component mount.
  $effect(() => {
    registry.registerCommand({
      id: "palette.open",
      title: "Open command palette",
      run: () => { open = true; },
    });
    registry.registerKeybinding("Mod+K", "palette.open");
    registry.registerCommand({
      id: "session.new",
      title: "New session",
      run: () => { open = false; onNewSession(); },
    });
    registry.registerCommand({
      id: "workspace.add",
      title: "Add workspace",
      run: () => { open = false; onAddWorkspace(); },
    });
  });

  function titleOfSession(session: Session): string {
    return session.name || [session.cmd, ...session.args].join(" ");
  }

  interface FilteredItem {
    kind: "command" | "session";
    command?: import("../../registry/types").Command;
    session?: Session;
    title: string;
  }

  let items = $derived<FilteredItem[]>(
    open
      ? [
          ...registry.listCommands().map((cmd) => ({ kind: "command" as const, command: cmd, title: cmd.title })),
          ...sessions.map((s) => ({ kind: "session" as const, session: s, title: titleOfSession(s) })),
        ]
      : [],
  );

  let filtered = $derived<FilteredItem[]>(
    query.length > 0
      ? items.filter((item) => {
          const t = item.title.toLowerCase();
          const q = query.toLowerCase();
          // Subsequence match: every character of q appears in order in t
          let qi = 0;
          for (let i = 0; i < t.length && qi < q.length; i++) {
            if (t[i] === q[qi]) qi++;
          }
          return qi === q.length;
        })
      : items,
  );

  $effect(() => {
    if (filtered.length > 0 && selectedIndex >= filtered.length) {
      selectedIndex = filtered.length - 1;
    } else if (filtered.length === 0) {
      selectedIndex = 0;
    }
  });

  function closePalette() {
    open = false;
    query = "";
    selectedIndex = 0;
  }

  function activateItem(item: FilteredItem) {
    if (item.kind === "command") {
      item.command!.run();
    } else if (item.kind === "session") {
      onSelectSession(item.session!);
      onSelectWorkspace(item.session!.workspaceId);
    }
    closePalette();
  }

  function handleOverlayKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      closePalette();
    }
  }

  function handleDialogKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      closePalette();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % filtered.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = selectedIndex <= 0 ? filtered.length - 1 : selectedIndex - 1;
    } else if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      activateItem(filtered[selectedIndex]);
    }
  }

  $effect(() => {
    if (open && inputRef) {
      inputRef.focus();
    }
  });
</script>

{#if open}
  <div
    class="overlay"
    role="presentation"
    onclick={closePalette}
    onkeydown={handleOverlayKeydown}
  >
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={handleDialogKeydown}
    >
      <input
        type="text"
        bind:this={inputRef}
        class="search-input"
        placeholder="Type a command or session name..."
        bind:value={query}
      />
      <ul class="results">
        {#each filtered as item, i (i)}
          <li class="result {i === selectedIndex ? 'selected' : ''}">
            <button
              type="button"
              class="row"
              onclick={() => { selectedIndex = i; activateItem(item); }}
              onmouseenter={() => { selectedIndex = i; }}
            >
              <span class="title">{item.title}</span>
              {#if item.kind === "session" && serverConfig}
                <span class="accent-swatch" style="background: {serverConfig.accent}"></span>
                <span class="server-label">{serverConfig.label}</span>
              {/if}
              <span class="badge">{item.kind === "command" ? "command" : "session"}</span>
            </button>
          </li>
        {/each}
        {#if filtered.length === 0}
          <li class="empty">No results</li>
        {/if}
      </ul>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: var(--sp-3);
    min-width: 400px;
    max-width: 90vw;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .search-input {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--fg);
    font-size: 0.95rem;
    font-family: var(--font-ui);
    box-sizing: border-box;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .search-input::placeholder {
    color: var(--fg-dim);
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 300px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .result {
    background: var(--bg-elevated);
  }

  .row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: var(--sp-2);
    background: none;
    border: none;
    font: inherit;
    color: var(--fg);
    text-align: left;
    cursor: pointer;
    padding: var(--sp-2) var(--sp-3);
  }

  .row:hover {
    background: var(--bg);
  }

  .selected {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
  }

  .selected .row {
    outline: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    font-size: 0.7rem;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .accent-swatch {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .server-label {
    font-size: 0.7rem;
    color: var(--fg-dim);
    white-space: nowrap;
  }

  .empty {
    padding: var(--sp-3);
    color: var(--fg-dim);
    text-align: center;
    font-size: 0.85rem;
  }
</style>
