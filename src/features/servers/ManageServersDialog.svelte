<script lang="ts">
  import { useServerRegistry } from "../../registry/context";
  import { isInsecureRemote } from "./insecureRemote";

  interface Draft {
    label: string;
    accent: string;
    url: string;
    token: string;
  }

  interface Props {
    open: boolean;
    accentPalette: string[];
    clientProtocolVersion: number | undefined;
    focusServerId?: string;
    onClose: () => void;
  }

  let { open, accentPalette, clientProtocolVersion, focusServerId, onClose }: Props = $props();
  const registry = useServerRegistry();
  let drafts = $state<Record<string, Draft>>(createDrafts());
  let confirmingRemoveId = $state<string>();
  let serverElements = $state<Record<string, HTMLElement>>({});
  let addLabel = $state("");
  let addUrl = $state("");
  let addToken = $state("");
  let addAuth = $state<"token" | "none">("token");
  let addAccent = $state("");

  function createDrafts(): Record<string, Draft> {
    return Object.fromEntries(registry.servers.map((conn) => [conn.config.id, {
      label: conn.config.label,
      accent: conn.config.accent,
      url: conn.config.url,
      token: "",
    }]));
  }

  function isDirty(id: string): boolean {
    const conn = registry.get(id);
    const draft = drafts[id];
    return !!conn && !!draft && (
      draft.label !== conn.config.label || draft.accent !== conn.config.accent
      || (conn.config.transport !== "local" && (draft.url !== conn.config.url || draft.token !== ""))
    );
  }

  async function save(id: string) {
    const draft = drafts[id];
    if (!draft || !isDirty(id)) return;
    const conn = registry.get(id);
    if (!conn) return;
    await registry.updateServer(id, {
      label: draft.label,
      accent: draft.accent,
      ...(conn.config.transport === "local" ? {} : { url: draft.url, token: draft.token || undefined }),
    });
    draft.token = "";
  }

  async function remove(id: string) {
    await registry.removeServer(id);
    confirmingRemoveId = undefined;
  }

  function canAdd(): boolean {
    return !!addUrl && (addAuth === "none" || !!addToken);
  }

  async function addServer() {
    if (!canAdd()) return;
    await registry.addServer({
      url: addUrl,
      label: addLabel || undefined,
      auth: addAuth,
      token: addAuth === "token" ? addToken : undefined,
      accent: addAccent || undefined,
    });
    addLabel = "";
    addUrl = "";
    addToken = "";
    addAuth = "token";
    addAccent = accentPalette[registry.servers.length % accentPalette.length] ?? "";
  }

  $effect(() => {
    if (open) {
      drafts = createDrafts();
      confirmingRemoveId = undefined;
    }
  });

  $effect(() => {
    if (!addAccent && accentPalette.length > 0) {
      addAccent = accentPalette[registry.servers.length % accentPalette.length];
    }
  });

  $effect(() => {
    if (open && focusServerId) {
      serverElements[focusServerId]?.scrollIntoView({ block: "nearest" });
    }
  });
</script>

{#if open}
  <div class="overlay" role="presentation" onclick={onClose} onkeydown={(e) => e.key === "Escape" && onClose()}>
    <div class="dialog" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && onClose()}>
      <h2>Manage servers</h2>

      <div class="server-list">
        {#each registry.servers as conn (conn.config.id)}
          {@const draft = drafts[conn.config.id]}
          {#if draft}
            <section class:focused={focusServerId === conn.config.id} class="server" bind:this={serverElements[conn.config.id]}>
              <label>
                Label
                <input type="text" bind:value={draft.label} />
              </label>

              <div class="field">
                <span>Accent</span>
                <div class="swatches">
                  {#each accentPalette as accent (accent)}
                    <button type="button" class:selected={draft.accent === accent} class="swatch" style:background={accent} aria-label={`Use ${accent} accent`} onclick={() => draft.accent = accent}></button>
                  {/each}
                </div>
              </div>

              {#if conn.config.transport === "local"}
                <p class="local-instance">Local ptys instance: <code>{conn.config.instance}</code>. It uses its private control socket and does not need a token.</p>
              {:else}
                <label>
                  URL
                  <input type="text" bind:value={draft.url} />
                </label>
                {#if isInsecureRemote(draft.url)}
                  <p class="warning">⚠ Insecure: plaintext connection to a non-loopback host. Use https/wss or a loopback address.</p>
                {/if}

                {#if conn.config.auth === "none"}
                  <p class="hint">This server is configured without authentication.</p>
                {:else}
                  <label>
                    Token
                    <input type="password" bind:value={draft.token} placeholder="Leave blank to keep the current token" />
                  </label>
                {/if}
              {/if}

              <p class="protocol">
                Protocol: {conn.info?.protocol ?? "-"}
                {#if conn.info?.protocol !== undefined && conn.info.protocol !== clientProtocolVersion}
                  <span class="mismatch-badge">protocol mismatch (client {clientProtocolVersion}, server {conn.info.protocol})</span>
                {/if}
              </p>

              <div class="row-actions">
                <button type="button" class="save" disabled={!isDirty(conn.config.id)} onclick={() => void save(conn.config.id)}>Save</button>
                {#if confirmingRemoveId === conn.config.id}
                  <span class="confirm-remove">Really remove? <button type="button" class="remove" onclick={() => void remove(conn.config.id)}>Yes</button> <button type="button" onclick={() => confirmingRemoveId = undefined}>No</button></span>
                {:else}
                  <button type="button" class="remove" onclick={() => confirmingRemoveId = conn.config.id}>Remove</button>
                {/if}
              </div>
            </section>
          {/if}
        {/each}
      </div>

      <section class="add-server">
        <h3>Add server</h3>
        <label>
          Label
          <input type="text" bind:value={addLabel} />
        </label>
        <label>
          URL
          <input type="text" bind:value={addUrl} />
        </label>
        {#if isInsecureRemote(addUrl)}
          <p class="warning">⚠ Insecure: plaintext connection to a non-loopback host. Use https/wss or a loopback address.</p>
        {/if}
        <div class="field">
          <span>Accent</span>
          <div class="swatches">
            {#each accentPalette as accent (accent)}
              <button type="button" class:selected={addAccent === accent} class="swatch" style:background={accent} aria-label={`Use ${accent} accent`} onclick={() => addAccent = accent}></button>
            {/each}
          </div>
        </div>
        <label>
          Authentication
          <select bind:value={addAuth}>
            <option value="token">Bearer token</option>
            <option value="none">None</option>
          </select>
        </label>
        {#if addAuth === "token"}
          <label>
            Token
            <input type="password" bind:value={addToken} />
          </label>
        {:else}
          <p class="hint">The server must be running with authentication disabled.</p>
        {/if}
        <div class="actions">
          <button type="button" class="cancel" onclick={onClose}>Close</button>
          <button type="button" class="save" disabled={!canAdd()} onclick={() => void addServer()}>Add</button>
        </div>
      </section>
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
    max-width: 90vw;
    min-width: 480px;
    max-height: 90vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  h2, h3 { margin: 0; color: var(--fg); }
  h2 { font-size: 1rem; }
  h3 { font-size: 0.9rem; }

  .server-list, .server, .add-server {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .server, .add-server {
    padding: var(--sp-3);
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  .local-instance { margin: 0; color: var(--fg-dim); line-height: 1.45; }

  .server.focused { border-color: var(--accent); }

  label, .field {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    color: var(--fg-dim);
    font-size: 0.85rem;
  }

  input, select {
    padding: var(--sp-1) var(--sp-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    font-size: 0.85rem;
  }

  input:focus, select:focus { outline: none; border-color: var(--accent); }

  .swatches { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .swatch { width: 20px; height: 20px; padding: 0; border: 1px solid var(--border); border-radius: 3px; cursor: pointer; }
  .swatch.selected { outline: 2px solid var(--fg); outline-offset: 1px; }

  .warning, .protocol, .hint { margin: 0; color: var(--fg-dim); font-size: 0.85rem; }
  .warning, .mismatch-badge { color: var(--status-warn); }
  .mismatch-badge { margin-left: var(--sp-2); }

  .row-actions, .actions { display: flex; align-items: center; gap: var(--sp-2); justify-content: flex-end; }
  button { padding: var(--sp-1) var(--sp-3); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; font-size: 0.85rem; }
  .save { background: var(--accent); border-color: var(--accent); color: #fff; }
  .save:disabled { opacity: 0.4; cursor: not-allowed; }
  .cancel { background: var(--bg); color: var(--fg-dim); }
  .remove { background: var(--bg); color: var(--status-offline); }
  .confirm-remove { color: var(--fg-dim); font-size: 0.85rem; }
</style>
