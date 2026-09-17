<script lang="ts">
  import { useServerRegistry } from "../../registry/context";
  import { nativeServerUrl, sameTransport, transportKind, validTransport } from "../../registry/serverTransport";
  import { defaultWslDistro, distroLabel, usableDistro, type WslServerTools, type WslTransport } from "../../registry/wsl";
  import { isInsecureRemote } from "./insecureRemote";
  import { PTYS_UPDATE_COMMAND, ptysUpdateFor } from "./ptysRelease";
  import { ptysReleaseWatch } from "./ptysReleaseWatch.svelte";
  import { emptySshFields, sshFields, sshProblem, sshTransport, type SshFields } from "./sshDraft";
  import { detectSummary, emptyWslFields, wslFields, wslFieldsTransport, wslProblem, type WslFields } from "./wslDraft";
  import { waitUntilOnline } from "./wslStart";

  interface Draft {
    label: string;
    accent: string;
    url: string;
    token: string;
    ssh: SshFields;
    wsl: WslFields;
  }

  interface Props {
    open: boolean;
    accentPalette: string[];
    clientProtocolVersion: number | undefined;
    focusServerId?: string;
    nativeTransports?: boolean;
    wsl?: WslServerTools;
    copyText: (text: string) => Promise<void>;
    onClose: () => void;
  }

  let { open, accentPalette, clientProtocolVersion, focusServerId, nativeTransports = false, wsl, copyText, onClose }: Props = $props();
  const registry = useServerRegistry();
  let drafts = $state<Record<string, Draft>>(createDrafts());
  let confirmingRemoveId = $state<string>();
  let copiedUpdateServerId = $state<string>();
  let serverElements = $state<Record<string, HTMLElement>>({});
  let addLabel = $state("");
  let addKind = $state<"url" | "ssh" | "wsl">("url");
  let addUrl = $state("");
  let addSsh = $state<SshFields>(emptySshFields());
  let addWsl = $state<WslFields>(emptyWslFields());
  let addToken = $state("");
  let addAuth = $state<"token" | "none">("token");
  let addAccent = $state("");
  let detecting = $state<Record<string, boolean>>({});
  let detected = $state<Record<string, string>>({});
  let startingId = $state<string>();
  let startFailures = $state<Record<string, string>>({});

  function createDrafts(): Record<string, Draft> {
    return Object.fromEntries(registry.servers.map((conn) => [conn.config.id, {
      label: conn.config.label,
      accent: conn.config.accent,
      url: conn.config.url,
      token: "",
      ssh: sshFields(conn.config.transport),
      wsl: wslFields(conn.config.transport),
    }]));
  }

  function isDirty(id: string): boolean {
    const conn = registry.get(id);
    const draft = drafts[id];
    if (!conn || !draft) return false;
    const transport = conn.config.transport;
    return draft.label !== conn.config.label || draft.accent !== conn.config.accent
      || (transport === undefined && (draft.url !== conn.config.url || draft.token !== ""))
      || (transportKind(transport) === "ssh" && !sameTransport(transport, sshTransport(draft.ssh)))
      || (wsl !== undefined && transportKind(transport) === "wsl" && !sameTransport(transport, wslFieldsTransport(draft.wsl)));
  }

  function canSave(id: string): boolean {
    const draft = drafts[id];
    const kind = transportKind(registry.get(id)?.config.transport);
    return isDirty(id) && !!draft
      && (kind !== "ssh" || sshProblem(draft.ssh) === undefined)
      && (kind !== "wsl" || wsl === undefined || wslProblem(draft.wsl) === undefined);
  }

  async function save(id: string) {
    const draft = drafts[id];
    if (!draft || !canSave(id)) return;
    const conn = registry.get(id);
    if (!conn) return;
    const transport = conn.config.transport;
    await registry.updateServer(id, {
      label: draft.label,
      accent: draft.accent,
      ...(transport === undefined ? { url: draft.url, token: draft.token || undefined } : {}),
      ...(transportKind(transport) === "ssh" ? { transport: sshTransport(draft.ssh) } : {}),
      ...(wsl !== undefined && transportKind(transport) === "wsl" ? { transport: wslFieldsTransport(draft.wsl) } : {}),
    });
    draft.token = "";
  }

  async function remove(id: string) {
    await registry.removeServer(id);
    confirmingRemoveId = undefined;
  }

  async function copyUpdateCommand(id: string) {
    await copyText(PTYS_UPDATE_COMMAND);
    copiedUpdateServerId = id;
    setTimeout(() => {
      if (copiedUpdateServerId === id) copiedUpdateServerId = undefined;
    }, 1500);
  }

  async function detect(key: string, fields: WslFields) {
    const distro = fields.distro.trim();
    const user = fields.user.trim() || undefined;
    if (!wsl || distro === "") return;
    detecting[key] = true;
    detected[key] = "";
    try {
      const probe = await wsl.detect(distro, user);
      if (fields.distro.trim() !== distro || (fields.user.trim() || undefined) !== user) {
        detected[key] = "The distribution or user changed while Detect ran. Run Detect again.";
        return;
      }
      fields.user = probe.user;
      fields.nodeBin = probe.nodeBin ?? "";
      detected[key] = detectSummary(probe);
    } catch (err) {
      detected[key] = err instanceof Error ? err.message : String(err);
    } finally {
      detecting[key] = false;
    }
  }

  async function startInWsl(id: string, transport: WslTransport) {
    if (!wsl) return;
    startingId = id;
    startFailures[id] = "";
    try {
      await wsl.start(transport);
      await wsl.refresh();
      const online = await waitUntilOnline(() => registry.get(id)?.status, () => registry.refresh(id));
      if (!online) startFailures[id] = `${transport.distro} started, but Choux could not connect to ptys yet.`;
    } catch (err) {
      startFailures[id] = err instanceof Error ? err.message : String(err);
    } finally {
      startingId = undefined;
    }
  }

  function canAdd(): boolean {
    if (addKind === "ssh") return sshProblem(addSsh) === undefined;
    if (addKind === "wsl") return wslProblem(addWsl) === undefined;
    return !!addUrl && (addAuth === "none" || !!addToken);
  }

  async function addServer() {
    if (!canAdd()) return;
    if (addKind === "url") {
      await registry.addServer({
        url: addUrl,
        label: addLabel || undefined,
        auth: addAuth,
        token: addAuth === "token" ? addToken : undefined,
        accent: addAccent || undefined,
      });
    } else {
      const transport = addKind === "ssh" ? sshTransport(addSsh) : wslFieldsTransport(addWsl);
      await registry.addServer({
        url: nativeServerUrl(transport),
        transport,
        label: addLabel || undefined,
        accent: addAccent || undefined,
      });
    }
    addLabel = "";
    addUrl = "";
    addSsh = emptySshFields();
    addWsl = emptyWslFields();
    detected.add = "";
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
    if (addKind === "wsl" && wsl && addWsl.distro === "") {
      addWsl.distro = defaultWslDistro(wsl.distros)?.name ?? "";
    }
  });

  $effect(() => {
    if (open && focusServerId) {
      serverElements[focusServerId]?.scrollIntoView({ block: "nearest" });
    }
  });
</script>

{#snippet sshInputs(fields: SshFields)}
  <label>
    SSH host
    <input type="text" bind:value={fields.host} placeholder="user@host or an ssh config alias" />
  </label>
  <label>
    ptys instance
    <input type="text" bind:value={fields.instance} />
  </label>
  <label>
    Node bin directory
    <input type="text" bind:value={fields.nodeBin} placeholder="Optional, e.g. /home/me/.nvm/versions/node/v24.21.0/bin" />
  </label>
  {#if fields.host.trim() !== "" && sshProblem(fields)}
    <p class="warning">⚠ {sshProblem(fields)}</p>
  {/if}
  <p class="hint">Choux runs <code>ssh {fields.host.trim() || "host"} ptys bridge</code> without a terminal, so the host needs key or agent authentication and a known host key. Password prompts are not supported. Set the node bin directory when <code>ptys</code> is not on the non-interactive PATH, as with nvm.</p>
{/snippet}

{#snippet wslInputs(fields: WslFields, key: string)}
  {@const distros = wsl?.distros ?? []}
  <label>
    WSL distribution
    <select bind:value={fields.distro}>
      {#if !distros.some((distro) => distro.name === fields.distro)}
        <option value={fields.distro}>{fields.distro || "Choose a distribution"}</option>
      {/if}
      {#each distros as distro (distro.name)}
        <option value={distro.name} disabled={!usableDistro(distro)}>{distroLabel(distro)}</option>
      {/each}
    </select>
  </label>
  <label>
    Linux user
    <input type="text" bind:value={fields.user} placeholder="Detect fills in the default user" />
  </label>
  <label>
    ptys instance
    <input type="text" bind:value={fields.instance} />
  </label>
  <label>
    Node bin directory
    <input type="text" bind:value={fields.nodeBin} placeholder="Set by Detect when Node.js is not on the system PATH" />
  </label>
  <div class="inline-action">
    <button type="button" class="copy" disabled={detecting[key] || fields.distro.trim() === ""} onclick={() => void detect(key, fields)}>{detecting[key] ? "Detecting..." : "Detect"}</button>
    {#if detected[key]}<span class="hint">{detected[key]}</span>{/if}
  </div>
  {#if fields.distro.trim() !== "" && wslProblem(fields)}
    <p class="warning">⚠ {wslProblem(fields)}</p>
  {/if}
  <p class="hint">Choux runs <code>wsl.exe -d {fields.distro.trim() || "distribution"} --exec ptys bridge</code>. Detect runs commands inside the distribution to find the user and Node.js, and starts the distribution when it is stopped.</p>
{/snippet}

{#if open}
  <div class="overlay" role="presentation" onclick={onClose} onkeydown={(e) => e.key === "Escape" && onClose()}>
    <div class="dialog" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && onClose()}>
      <h2>Manage servers</h2>

      <div class="server-list">
        {#each registry.servers as conn (conn.config.id)}
          {@const draft = drafts[conn.config.id]}
          {@const ptysUpdate = ptysUpdateFor(conn.info?.version, ptysReleaseWatch.latest)}
          {@const transport = conn.config.transport}
          {@const kind = transportKind(transport)}
          {@const valid = validTransport(transport)}
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

              {#if transport === undefined}
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
              {:else if kind === "ssh"}
                {@render sshInputs(draft.ssh)}
              {:else if kind === "wsl" && wsl}
                {@render wslInputs(draft.wsl, conn.config.id)}
                {#if valid?.kind === "wsl" && conn.status !== "online"}
                  <div class="inline-action">
                    <button type="button" class="copy" disabled={startingId === conn.config.id} onclick={() => void startInWsl(conn.config.id, valid)}>{startingId === conn.config.id ? "Starting..." : `Start in WSL (${valid.distro})`}</button>
                    {#if startFailures[conn.config.id]}<span class="warning">{startFailures[conn.config.id]}</span>{/if}
                  </div>
                {/if}
              {:else if valid?.kind === "local"}
                <p class="native-connection">Local ptys instance: <code>{valid.instance}</code>. It uses its private control socket and does not need a token.</p>
              {:else if valid?.kind === "wsl"}
                <p class="native-connection">WSL distribution <code>{valid.distro}</code> as <code>{valid.user}</code>, ptys instance <code>{valid.instance}</code>.</p>
              {:else}
                <p class="warning">⚠ Choux cannot read this server's connection settings. Remove it and add it again.</p>
              {/if}

              <p class="protocol">
                Protocol: {conn.info?.protocol ?? "-"}
                {#if conn.info?.protocol !== undefined && conn.info.protocol !== clientProtocolVersion}
                  <span class="mismatch-badge">protocol mismatch (client {clientProtocolVersion}, server {conn.info.protocol})</span>
                {/if}
              </p>

              <p class="ptys-version">
                ptys: {conn.info?.version ?? "-"}
                {#if ptysUpdate}
                  <span class="update-badge">update available: {ptysUpdate}</span>
                {/if}
              </p>
              {#if ptysUpdate}
                <div class="update-command">
                  <p class="hint">Update on the host running this server. It takes effect when ptys restarts.</p>
                  <div class="command-row">
                    <code>{PTYS_UPDATE_COMMAND}</code>
                    <button type="button" class="copy" onclick={() => void copyUpdateCommand(conn.config.id)}>{copiedUpdateServerId === conn.config.id ? "Copied" : "Copy"}</button>
                  </div>
                </div>
              {/if}

              <div class="row-actions">
                <button type="button" class="save" disabled={!canSave(conn.config.id)} onclick={() => void save(conn.config.id)}>Save</button>
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
        {#if nativeTransports}
          <label>
            Connection
            <select bind:value={addKind}>
              <option value="url">URL</option>
              <option value="ssh">SSH</option>
              {#if wsl}
                <option value="wsl">WSL</option>
              {/if}
            </select>
          </label>
        {/if}
        {#if addKind === "ssh" && nativeTransports}
          {@render sshInputs(addSsh)}
        {:else if addKind === "wsl" && nativeTransports && wsl}
          {@render wslInputs(addWsl, "add")}
        {:else}
          <label>
            URL
            <input type="text" bind:value={addUrl} />
          </label>
          {#if isInsecureRemote(addUrl)}
            <p class="warning">⚠ Insecure: plaintext connection to a non-loopback host. Use https/wss or a loopback address.</p>
          {/if}
        {/if}
        <div class="field">
          <span>Accent</span>
          <div class="swatches">
            {#each accentPalette as accent (accent)}
              <button type="button" class:selected={addAccent === accent} class="swatch" style:background={accent} aria-label={`Use ${accent} accent`} onclick={() => addAccent = accent}></button>
            {/each}
          </div>
        </div>
        {#if addKind === "url" || !nativeTransports}
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

  .native-connection { margin: 0; color: var(--fg-dim); line-height: 1.45; }

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

  .warning, .protocol, .ptys-version, .hint { margin: 0; color: var(--fg-dim); font-size: 0.85rem; }
  .hint { line-height: 1.45; }
  .warning, .mismatch-badge, .update-badge { color: var(--status-warn); }
  .mismatch-badge, .update-badge { margin-left: var(--sp-2); }

  .update-command { display: flex; flex-direction: column; gap: var(--sp-1); }
  .command-row { display: flex; align-items: center; gap: var(--sp-2); }
  .command-row code {
    flex: 1;
    padding: var(--sp-1) var(--sp-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    font-size: 0.8rem;
  }
  .inline-action { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); }

  .row-actions, .actions { display: flex; align-items: center; gap: var(--sp-2); justify-content: flex-end; }
  button { padding: var(--sp-1) var(--sp-3); border: 1px solid var(--border); border-radius: 3px; cursor: pointer; font-size: 0.85rem; }
  .save { background: var(--accent); border-color: var(--accent); color: #fff; }
  .save:disabled { opacity: 0.4; cursor: not-allowed; }
  .cancel, .copy { background: var(--bg); color: var(--fg-dim); }
  .remove { background: var(--bg); color: var(--status-offline); }
  .confirm-remove { color: var(--fg-dim); font-size: 0.85rem; }
</style>
