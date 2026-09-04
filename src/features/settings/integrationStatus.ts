import type { Session } from "@pty-server/protocol";
import type { AgentState } from "../../registry/types";
import { agentLabels, detectAgentId, reportedAgentId, type AgentId } from "../sessions/agentDetect";
import { integrationInstall } from "../sessions/integrationHint";

export type IntegrationStatus = "reporting" | "silent" | "absent";

export interface IntegrationServerInput {
  readonly sessions: readonly Session[];
  readonly agentStates: Readonly<Record<string, AgentState>>;
}

export interface IntegrationRow {
  readonly agent: AgentId;
  readonly label: string;
  readonly status: IntegrationStatus;
  readonly sessions: number;
  readonly reporting: number;
  readonly command?: string;
  readonly docs: string;
}

export function integrationStatusLabel(status: IntegrationStatus): string {
  if (status === "reporting") return "Reporting";
  return status === "silent" ? "Not reporting" : "No sessions";
}

interface AgentSessions {
  readonly running: Set<string>;
  readonly reporting: Set<string>;
}

export function integrationRows(servers: readonly IntegrationServerInput[]): IntegrationRow[] {
  const found = new Map<AgentId, AgentSessions>();
  for (const agent of Object.keys(agentLabels) as AgentId[]) {
    found.set(agent, { running: new Set(), reporting: new Set() });
  }

  servers.forEach((server, index) => {
    for (const session of server.sessions) {
      const agent = detectAgentId(session);
      if (agent !== undefined) found.get(agent)?.running.add(`${index}:${session.id}`);
    }

    for (const state of Object.values(server.agentStates)) {
      const agent = reportedAgentId(state.agent);
      if (agent === undefined) continue;
      const sessions = found.get(agent);
      if (sessions === undefined) continue;
      sessions.running.add(`${index}:${state.sessionId}`);
      sessions.reporting.add(`${index}:${state.sessionId}`);
    }
  });

  return [...found].map(([agent, sessions]) => {
    const install = integrationInstall(agent);
    return {
      agent,
      label: install.label,
      status: statusFor(sessions),
      sessions: sessions.running.size,
      reporting: sessions.reporting.size,
      command: install.command,
      docs: install.docs,
    };
  });
}

function statusFor(sessions: AgentSessions): IntegrationStatus {
  if (sessions.running.size === 0) return "absent";
  return sessions.reporting.size > 0 ? "reporting" : "silent";
}
