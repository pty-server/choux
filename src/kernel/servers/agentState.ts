import type { AgentState } from "../../registry/types";

export interface AgentStateData {
  agent: string;
  event: string;
  at: number;
  pane?: string;
  cwd?: string;
  tool?: string;
  detail?: string;
  message?: string;
  agentSessionId?: string;
}

export const AGENT_STATE_TTL_MS = 10 * 60_000;

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isAgentStateData(value: unknown): value is AgentStateData {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.agent !== "string" || record.agent.length === 0) return false;
  if (typeof record.event !== "string" || record.event.length === 0) return false;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return false;
  return isOptionalString(record.pane)
    && isOptionalString(record.cwd)
    && isOptionalString(record.tool)
    && isOptionalString(record.detail)
    && isOptionalString(record.message)
    && isOptionalString(record.agentSessionId);
}

export function reduceAgentState(
  previous: AgentState | undefined,
  sessionId: string,
  data: AgentStateData,
): AgentState | undefined {
  const outOfOrder = previous !== undefined && data.at < previous.updatedAt;
  if (outOfOrder) return previous;
  if (data.event === "SessionEnd") return undefined;

  const carried: AgentState = {
    agent: data.agent,
    activity: previous?.activity ?? "idle",
    sessionId,
    pane: data.pane,
    cwd: data.cwd ?? previous?.cwd,
    tool: previous?.tool,
    detail: previous?.detail,
    message: previous?.message,
    subagents: previous?.subagents ?? 0,
    updatedAt: data.at,
  };
  const fresh: AgentState = { ...carried, tool: undefined, detail: undefined, message: undefined };

  switch (data.event) {
    case "SessionStart":
      return { ...fresh, activity: "idle", subagents: 0 };
    case "UserPromptSubmit":
      return { ...fresh, activity: "busy" };
    case "PreToolUse":
      return {
        ...fresh,
        activity: "tool",
        tool: data.tool,
        detail: data.detail,
        subagents: data.tool === "Task" ? carried.subagents + 1 : carried.subagents,
      };
    case "PostToolUse":
      return { ...fresh, activity: "busy" };
    case "PermissionRequest":
    case "Notification":
      return {
        ...carried,
        activity: "waiting",
        tool: data.tool ?? carried.tool,
        detail: data.detail ?? carried.detail,
        message: data.message ?? carried.message,
      };
    case "Stop":
      return { ...fresh, activity: "idle", subagents: 0 };
    case "SubagentStop":
      return { ...carried, subagents: Math.max(0, carried.subagents - 1) };
    case "PreCompact":
      return { ...fresh, activity: "compacting" };
    default:
      return carried;
  }
}

export function sweepAgentStates(
  states: Readonly<Record<string, AgentState>>,
  now: number,
): Readonly<Record<string, AgentState>> | undefined {
  const kept = Object.entries(states).filter(([, state]) => now - state.updatedAt < AGENT_STATE_TTL_MS);
  return kept.length === Object.keys(states).length ? undefined : Object.fromEntries(kept);
}
