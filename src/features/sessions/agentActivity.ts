import type { AgentState } from "../../registry/types";

const activityText: Readonly<Record<AgentState["activity"], string>> = {
  idle: "Idle",
  busy: "Working",
  tool: "Working",
  waiting: "Awaiting approval",
  compacting: "Compacting",
};

export function activityLabel(state: AgentState): string {
  const base = state.activity === "tool" && state.tool ? `Running ${state.tool}` : activityText[state.activity];
  const subagents = state.subagents > 0 ? `, ${state.subagents} subagent${state.subagents === 1 ? "" : "s"}` : "";
  return `${base}${subagents}`;
}

export function activityDetail(state: AgentState): string {
  const tool = state.activity === "tool" && state.tool ? state.tool : "";
  const subagents = state.subagents > 0 ? `+${state.subagents}` : "";
  return [tool, subagents].filter(Boolean).join(" ");
}

export function activityTitle(state: AgentState): string {
  const staleNote = state.stale === true
    ? `no update since ${new Date(state.updatedAt).toLocaleTimeString()}`
    : "";
  return [activityLabel(state), state.message ?? state.detail, staleNote].filter(Boolean).join(" - ");
}