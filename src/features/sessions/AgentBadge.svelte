<script lang="ts">
  import type { Session } from "@pty-server/protocol";
  import { useServerRegistry } from "../../registry/context";
  import { agentStateKey } from "../../registry/agentStateKey";
  import AgentStatusBadge from "./AgentStatusBadge.svelte";
  import IntegrationHint from "./IntegrationHint.svelte";
  import { detectAgent, detectAgentId } from "./agentDetect";
  import {
    INTEGRATION_HINT_DELAY_MS,
    clearAgentSighting,
    dismissIntegrationHint,
    hintKey,
    isIntegrationHintDismissed,
    shouldHintMissingIntegration,
    trackAgentSighting,
  } from "./integrationHint";

  interface Props {
    session: Session;
    serverId: string;
    copyText: (text: string) => Promise<void>;
    openUrl: (url: string) => void;
  }

  let { session, serverId, copyText, openUrl }: Props = $props();

  const serverRegistry = useServerRegistry();

  let state = $derived(serverRegistry.get(serverId)?.agentStates[agentStateKey(session.id, undefined)]);
  let agent = $derived(detectAgent(session) ?? state?.agent);
  let awaitingApproval = $derived(
    serverRegistry.pendingQuestions.some(
      (question) => question.serverId === serverId && question.sessionId === session.id,
    ),
  );

  let agentId = $derived(detectAgentId(session));
  let key = $derived(hintKey(serverId, session.id));
  let dismissed = $derived(isIntegrationHintDismissed(key));

  let firstSeenAt = $state<number | undefined>(undefined);
  let now = $state(Date.now());

  $effect(() => {
    if (agentId === undefined || state !== undefined) {
      clearAgentSighting(key);
      firstSeenAt = undefined;
      return;
    }
    const seenAt = trackAgentSighting(key, Date.now());
    firstSeenAt = seenAt;
    now = Date.now();
    const remaining = seenAt + INTEGRATION_HINT_DELAY_MS - now;
    if (remaining <= 0) return;
    const timer = setTimeout(() => (now = Date.now()), remaining);
    return () => clearTimeout(timer);
  });

  let hinting = $derived(
    shouldHintMissingIntegration({ agent: agentId, state, firstSeenAt, now, dismissed }),
  );
</script>

<div class="row">
  <AgentStatusBadge {agent} {state} {awaitingApproval} />
  {#if hinting && agentId}
    <IntegrationHint
      agent={agentId}
      {copyText}
      {openUrl}
      onDismiss={() => {
        dismissIntegrationHint(key);
        dismissed = true;
      }}
    />
  {/if}
</div>

<style>
  .row {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--sp-1);
    padding: 0 var(--sp-2) var(--sp-2) var(--sp-2);
  }
</style>
