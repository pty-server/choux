<script lang="ts">
  import type { Session } from "@pty-server/protocol";
  import { useServerRegistry } from "../../registry/context";
  import { detectAgent } from "./agentDetect";

  interface Props {
    session: Session;
    serverId: string;
  }

  let { session, serverId }: Props = $props();

  const serverRegistry = useServerRegistry();

  let agent = $derived(detectAgent(session));
  let awaitingApproval = $derived(
    serverRegistry.pendingQuestions.some(
      (question) => question.serverId === serverId && question.sessionId === session.id,
    ),
  );
</script>

{#if agent}
  <div class="agent">
    <span class="badge">{agent}</span>
    {#if awaitingApproval}
      <span class="awaiting">Awaiting approval</span>
    {/if}
  </div>
{/if}

<style>
  .agent {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: var(--sp-2);
    padding: 0 var(--sp-2) var(--sp-2) var(--sp-2);
    font-size: 0.75rem;
  }

  .badge {
    flex: 0 0 auto;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--fg-dim);
  }

  .awaiting {
    flex: 0 0 auto;
    color: var(--accent);
  }

</style>
