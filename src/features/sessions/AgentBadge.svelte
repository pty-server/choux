<script lang="ts">
  import type { Session } from "@pty-server/protocol";
  import { useServerRegistry } from "../../registry/context";
  import { agentStateKey } from "../../registry/agentStateKey";
  import AgentStatusBadge from "./AgentStatusBadge.svelte";
  import { detectAgent } from "./agentDetect";

  interface Props {
    session: Session;
    serverId: string;
  }

  let { session, serverId }: Props = $props();

  const serverRegistry = useServerRegistry();

  let state = $derived(serverRegistry.get(serverId)?.agentStates[agentStateKey(session.id, undefined)]);
  let agent = $derived(detectAgent(session) ?? state?.agent);
  let awaitingApproval = $derived(
    serverRegistry.pendingQuestions.some(
      (question) => question.serverId === serverId && question.sessionId === session.id,
    ),
  );
</script>

<div class="row">
  <AgentStatusBadge {agent} {state} {awaitingApproval} />
</div>

<style>
  .row {
    display: flex;
    min-width: 0;
    padding: 0 var(--sp-2) var(--sp-2) var(--sp-2);
  }
</style>
