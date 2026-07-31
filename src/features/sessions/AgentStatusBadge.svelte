<script lang="ts">
  import type { AgentState } from "../../registry/types";
  import AgentActivityIcon from "./AgentActivityIcon.svelte";
  import { activityDetail, activityLabel, activityTitle } from "./agentActivity";

  interface Props {
    agent?: string;
    state?: AgentState;
    awaitingApproval?: boolean;
  }

  let { agent, state, awaitingApproval = false }: Props = $props();

  let activity = $derived(state?.activity ?? (awaitingApproval ? "waiting" : undefined));
  let label = $derived(state ? activityLabel(state) : "Awaiting approval");
  let detail = $derived(state ? activityDetail(state) : "");
</script>

{#if agent || activity}
  <span class="agent" title={state ? activityTitle(state) : label}>
    {#if agent}
      <span class="badge">{agent}</span>
    {/if}
    {#if activity}
      <AgentActivityIcon {activity} {label} />
    {/if}
    {#if detail}
      <span class="detail">{detail}</span>
    {/if}
  </span>
{/if}

<style>
  .agent {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--sp-1);
    font-size: 0.75rem;
  }

  .badge {
    flex: 0 0 auto;
    margin-right: 1px;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--fg-dim);
  }

  .detail {
    overflow: hidden;
    color: var(--fg-dim);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
