<script lang="ts">
  import { useServerRegistry } from "../../registry/context";
  import { INTEGRATION_DOCS_URL } from "../sessions/integrationHint";
  import { integrationRows, integrationStatusLabel } from "./integrationStatus";

  interface Props {
    copyText: (text: string) => Promise<void>;
    openUrl: (url: string) => void;
  }

  let { copyText, openUrl }: Props = $props();

  const serverRegistry = useServerRegistry();

  let rows = $derived(integrationRows(serverRegistry.servers));
  let copiedAgent = $state<string | undefined>(undefined);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(agent: string, text: string) {
    await copyText(text);
    copiedAgent = agent;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedAgent = undefined), 1500);
  }

  $effect(() => () => clearTimeout(copiedTimer));
</script>

<section class="settings-card integrations-card">
  <div class="card-heading">
    <div>
      <h2>Integrations</h2>
      <p>Agent bridges report live status and route permission requests to Choux. They install where the agent runs, which is the ptys host - not necessarily this machine.</p>
    </div>
    <button type="button" onclick={() => openUrl(INTEGRATION_DOCS_URL)}>Open docs</button>
  </div>

  <ul class="integrations">
    {#each rows as row (row.agent)}
      <li>
        <div class="row-heading">
          <span class="name">{row.label}</span>
          <span class="status {row.status}">{integrationStatusLabel(row.status)}</span>
          {#if row.sessions > 0}
            <span class="counts">{row.reporting} of {row.sessions} session{row.sessions === 1 ? "" : "s"} reporting</span>
          {/if}
        </div>

        {#if row.command}
          <pre>{row.command}</pre>
          <button type="button" onclick={() => void copy(row.agent, row.command ?? "")}>
            {copiedAgent === row.agent ? "Copied" : "Copy install commands"}
          </button>
        {:else}
          <div class="manual">
            <p>Installs by hand.</p>
            <button type="button" onclick={() => openUrl(row.docs)}>Open instructions</button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>

  <p>Status only turns green once an agent sends its first event, so a freshly connected server shows nothing until the agent is used.</p>
</section>

<style>
  .settings-card { padding: var(--sp-4); border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); }
  .card-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  .card-heading > div:first-child { flex: 1 1 16rem; min-width: 0; }
  .card-heading > button { flex: 0 0 auto; }
  h2, p { margin: 0; }
  h2 { font-size: 1rem; }
  p { color: var(--fg-dim); font-size: 0.85rem; }
  button { padding: var(--sp-1) var(--sp-3); border: 1px solid var(--border); border-radius: 3px; background: var(--bg); color: var(--fg); font: inherit; cursor: pointer; }
  button:hover { border-color: var(--fg-dim); }
  .integrations { display: flex; flex-direction: column; gap: var(--sp-2); margin: var(--sp-3) 0; padding: 0; list-style: none; }
  .integrations li { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border); border-radius: 4px; }
  .row-heading { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .name { font-weight: 600; }
  .status {
    padding: 1px 8px; border: 1px solid var(--border); border-radius: 999px;
    font-size: 0.75rem; color: var(--fg-dim);
  }
  .status.reporting { border-color: var(--status-online); color: var(--status-online); }
  .status.silent { border-color: var(--status-warn); color: var(--status-warn); }
  .counts { font-size: 0.75rem; color: var(--fg-dim); }
  pre {
    overflow-x: auto; align-self: stretch; margin: 0; padding: var(--sp-2);
    border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated);
    font-family: var(--font-mono, monospace); font-size: 0.75rem;
  }
  .manual { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .manual p { font-size: 0.8rem; }
</style>
