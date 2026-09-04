import type { AgentState } from "../../registry/types";
import { agentLabels, type AgentId } from "./agentDetect";

/** Agent state only arrives on activity, so a working install looks missing until the
 * agent is used. Waiting keeps an idle session from being accused of the wrong thing. */
export const INTEGRATION_HINT_DELAY_MS = 60_000;

export const INTEGRATION_DOCS_URL =
  "https://github.com/pty-server/choux/blob/main/integrations/README.md";

const installCommands: Partial<Readonly<Record<AgentId, string>>> = {
  claude: "claude plugin marketplace add pty-server/choux\nclaude plugin install choux@pty-server",
};

export interface IntegrationInstall {
  readonly label: string;
  readonly command?: string;
  readonly docs: string;
}

export function integrationInstall(agent: AgentId): IntegrationInstall {
  return { label: agentLabels[agent], command: installCommands[agent], docs: INTEGRATION_DOCS_URL };
}

export interface IntegrationHintInput {
  agent?: AgentId;
  state?: AgentState;
  firstSeenAt?: number;
  now: number;
  dismissed: boolean;
}

export function shouldHintMissingIntegration(input: IntegrationHintInput): boolean {
  const { agent, state, firstSeenAt, now, dismissed } = input;
  if (agent === undefined || state !== undefined || dismissed) return false;
  if (firstSeenAt === undefined) return false;
  return now - firstSeenAt >= INTEGRATION_HINT_DELAY_MS;
}

/** Kept outside the component so scrolling a session row out of view and back does not
 * restart the wait. */
const firstSeen = new Map<string, number>();
const dismissals = new Set<string>();

export function hintKey(serverId: string, sessionId: string): string {
  return `${serverId}:${sessionId}`;
}

export function trackAgentSighting(key: string, now: number): number {
  const seenAt = firstSeen.get(key);
  if (seenAt !== undefined) return seenAt;
  firstSeen.set(key, now);
  return now;
}

export function clearAgentSighting(key: string): void {
  firstSeen.delete(key);
}

export function dismissIntegrationHint(key: string): void {
  dismissals.add(key);
}

export function isIntegrationHintDismissed(key: string): boolean {
  return dismissals.has(key);
}

export function resetIntegrationHints(): void {
  firstSeen.clear();
  dismissals.clear();
}
