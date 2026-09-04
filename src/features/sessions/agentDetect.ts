import type { Session } from "@pty-server/protocol";
import { basename } from "../../registry/basename";

export const agentLabels = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
} as const satisfies Readonly<Record<string, string>>;

export type AgentId = keyof typeof agentLabels;

function isAgentId(value: string): value is AgentId {
  return value in agentLabels;
}

const reportedAgentIds: Readonly<Record<string, AgentId>> = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
};

export function reportedAgentId(agent: string | undefined): AgentId | undefined {
  return agent === undefined ? undefined : reportedAgentIds[agent];
}

export function agentIdFor(command: string | undefined): AgentId | undefined {
  if (command === undefined || command.length === 0) return undefined;
  const id = basename(command);
  return isAgentId(id) ? id : undefined;
}

export function agentLabelFor(command: string | undefined): string | undefined {
  const id = agentIdFor(command);
  return id === undefined ? undefined : agentLabels[id];
}

export function detectAgentId(session: Session): AgentId | undefined {
  if (session.exited !== undefined) return undefined;
  for (const candidate of [session.process, session.cmd, session.args[0]]) {
    const id = agentIdFor(candidate);
    if (id !== undefined) return id;
  }
  return undefined;
}

export function detectAgent(session: Session): string | undefined {
  const id = detectAgentId(session);
  return id === undefined ? undefined : agentLabels[id];
}
