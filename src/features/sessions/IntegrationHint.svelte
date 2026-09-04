<script lang="ts">
  import type { AgentId } from "./agentDetect";
  import { integrationInstall } from "./integrationHint";

  interface Props {
    agent: AgentId;
    copyText: (text: string) => Promise<void>;
    openUrl: (url: string) => void;
    onDismiss: () => void;
  }

  let { agent, copyText, openUrl, onDismiss }: Props = $props();

  let open = $state(false);
  let copied = $state(false);

  let install = $derived(integrationInstall(agent));

  async function copy(): Promise<void> {
    if (install.command === undefined) return;
    await copyText(install.command);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="hint">
  <button
    class="chip"
    type="button"
    aria-expanded={open}
    title="{install.label} is running here but has not reported to Choux"
    onclick={() => (open = !open)}
  >
    no integration
  </button>

  {#if open}
    <div class="panel">
      <p>
        {install.label} is running here but has not reported to Choux. Permission requests and
        live status need its integration installed where the agent runs.
      </p>

      {#if install.command}
        <pre>{install.command}</pre>
        <div class="actions">
          <button type="button" onclick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
          <button type="button" onclick={onDismiss}>Dismiss</button>
        </div>
      {:else}
        <div class="actions">
          <button type="button" onclick={() => openUrl(install.docs)}>Open instructions</button>
          <button type="button" onclick={onDismiss}>Dismiss</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .hint {
    min-width: 0;
    font-size: 0.75rem;
  }

  .chip {
    padding: 1px 6px;
    border: 1px dashed var(--border);
    border-radius: 999px;
    background: none;
    color: var(--fg-dim);
    font: inherit;
    cursor: pointer;
  }

  .chip:hover {
    color: var(--fg);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
    padding: var(--sp-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-elevated);
  }

  p {
    margin: 0;
    color: var(--fg-dim);
    line-height: 1.4;
  }

  pre {
    overflow-x: auto;
    margin: 0;
    color: var(--fg);
    font-family: var(--font-mono, monospace);
    font-size: 0.7rem;
  }

  .actions {
    display: flex;
    gap: var(--sp-2);
  }

  .actions button {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    color: var(--fg-dim);
    font: inherit;
    cursor: pointer;
  }

  .actions button:hover {
    color: var(--fg);
    border-color: var(--accent);
  }
</style>
