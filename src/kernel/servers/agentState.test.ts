import { describe, expect, it } from "vitest";
import type { AgentState } from "../../registry/types";
import { AGENT_ACTIVE_STALE_MS, AGENT_STATE_TTL_MS, AGENT_WAITING_STALE_MS, isAgentStateData, isAgentStateStale, reduceAgentState, sweepAgentStates } from "./agentState";

function event(name: string, at: number, extra: Record<string, unknown> = {}) {
  return { agent: "claude-code", event: name, at, ...extra } as never;
}

function reduce(previous: AgentState | undefined, name: string, at: number, extra: Record<string, unknown> = {}) {
  return reduceAgentState(previous, "session-1", event(name, at, extra));
}

describe("isAgentStateData", () => {
  it("accepts the minimum envelope", () => {
    expect(isAgentStateData({ agent: "claude-code", event: "Stop", at: 1 })).toBe(true);
  });

  it("rejects a missing or empty required field", () => {
    expect(isAgentStateData({ event: "Stop", at: 1 })).toBe(false);
    expect(isAgentStateData({ agent: "", event: "Stop", at: 1 })).toBe(false);
    expect(isAgentStateData({ agent: "claude-code", event: "Stop" })).toBe(false);
    expect(isAgentStateData({ agent: "claude-code", event: "Stop", at: "1" })).toBe(false);
  });

  it("rejects a non-string optional field", () => {
    expect(isAgentStateData({ agent: "claude-code", event: "Stop", at: 1, pane: 3 })).toBe(false);
  });

  it("rejects anything that is not an object", () => {
    expect(isAgentStateData(null)).toBe(false);
    expect(isAgentStateData("Stop")).toBe(false);
  });
});

describe("reduceAgentState", () => {
  it("starts idle and records the reporting pane", () => {
    const state = reduce(undefined, "SessionStart", 10, { pane: "%3", cwd: "/repo" });

    expect(state).toMatchObject({ activity: "idle", sessionId: "session-1", pane: "%3", cwd: "/repo", subagents: 0 });
  });

  it("walks a turn from prompt through tool to idle", () => {
    let state = reduce(undefined, "SessionStart", 10);
    state = reduce(state, "UserPromptSubmit", 20);
    expect(state?.activity).toBe("busy");

    state = reduce(state, "PreToolUse", 30, { tool: "Bash", detail: "npm test" });
    expect(state).toMatchObject({ activity: "tool", tool: "Bash", detail: "npm test" });

    state = reduce(state, "PostToolUse", 40);
    expect(state).toMatchObject({ activity: "busy", tool: undefined, detail: undefined });

    state = reduce(state, "Stop", 50);
    expect(state?.activity).toBe("idle");
  });

  it("carries the message and asked-about tool while waiting, and clears them on the next turn", () => {
    let state = reduce(undefined, "PermissionRequest", 10, { message: "Allow Bash?", tool: "Bash", detail: "rm -rf build" });
    expect(state).toMatchObject({ activity: "waiting", message: "Allow Bash?", tool: "Bash", detail: "rm -rf build" });

    state = reduce(state, "Stop", 20);
    expect(state).toMatchObject({ message: undefined, tool: undefined, detail: undefined });
  });

  it("counts a Task tool as a subagent and stops at zero", () => {
    let state = reduce(undefined, "PreToolUse", 10, { tool: "Task" });
    state = reduce(state, "PreToolUse", 20, { tool: "Task" });
    expect(state?.subagents).toBe(2);

    state = reduce(state, "SubagentStop", 30);
    expect(state?.subagents).toBe(1);

    state = reduce(state, "SubagentStop", 40);
    state = reduce(state, "SubagentStop", 50);
    expect(state?.subagents).toBe(0);
  });

  it("keeps the activity across a SubagentStop", () => {
    const previous = reduce(undefined, "PreToolUse", 10, { tool: "Task" });

    expect(reduce(previous, "SubagentStop", 20)?.activity).toBe("tool");
  });

  it("drops the entry on SessionEnd", () => {
    const previous = reduce(undefined, "UserPromptSubmit", 10);

    expect(reduce(previous, "SessionEnd", 20)).toBeUndefined();
  });

  it("reports compaction", () => {
    expect(reduce(undefined, "PreCompact", 10)?.activity).toBe("compacting");
  });

  it("keeps an unknown event alive without changing the activity", () => {
    const previous = reduce(undefined, "UserPromptSubmit", 10);
    const state = reduce(previous, "SomethingNew", 20);

    expect(state).toMatchObject({ activity: "busy", updatedAt: 20 });
  });

  it("ignores an event that arrives out of order", () => {
    const previous = reduce(undefined, "Stop", 50);

    expect(reduce(previous, "UserPromptSubmit", 20)).toBe(previous);
  });

  it("does not resurrect an ended agent with a late event", () => {
    const previous = reduce(undefined, "PreToolUse", 50, { tool: "Bash" });
    const ended = reduce(previous, "SessionEnd", 60);

    expect(ended).toBeUndefined();
  });
});

describe("sweepAgentStates", () => {
  const fresh = reduce(undefined, "Stop", 1_000_000) as AgentState;
  const stale = reduce(undefined, "Stop", 1) as AgentState;

  it("returns undefined when nothing expired, so callers can skip the write", () => {
    expect(sweepAgentStates({ "pane:%3": fresh }, 1_000_000)).toBeUndefined();
  });

  it("drops entries past the TTL", () => {
    const swept = sweepAgentStates({ "pane:%3": fresh, "pane:%4": stale }, 1_000_000 + AGENT_STATE_TTL_MS - 1);

    expect(swept).toEqual({ "pane:%3": fresh });
  });

  it("flags an active state that stopped reporting", () => {
    const running = reduce(undefined, "PreToolUse", 1_000_000, { tool: "Bash" }) as AgentState;
    const swept = sweepAgentStates({ "pane:%3": running }, 1_000_000 + AGENT_ACTIVE_STALE_MS);

    expect(swept?.["pane:%3"]).toEqual({ ...running, stale: true });
  });

  it("keeps the reported activity when it goes stale", () => {
    const running = reduce(undefined, "PreToolUse", 1_000_000, { tool: "Bash" }) as AgentState;
    const swept = sweepAgentStates({ "pane:%3": running }, 1_000_000 + AGENT_ACTIVE_STALE_MS);

    expect(swept?.["pane:%3"]?.activity).toBe("tool");
    expect(swept?.["pane:%3"]?.tool).toBe("Bash");
  });

  it("clears the flag once the agent reports again", () => {
    const flagged = { ...(reduce(undefined, "PreToolUse", 1_000_000, { tool: "Bash" }) as AgentState), stale: true };
    const swept = sweepAgentStates({ "pane:%3": flagged }, 1_000_000 + 1);

    expect(swept?.["pane:%3"]?.stale).toBe(false);
  });

  it("leaves an idle state alone", () => {
    expect(sweepAgentStates({ "pane:%3": fresh }, 1_000_000 + AGENT_ACTIVE_STALE_MS)).toBeUndefined();
  });
});

describe("isAgentStateStale", () => {
  const at = 1_000_000;
  const waiting = reduce(undefined, "PermissionRequest", at, { message: "Allow?" }) as AgentState;
  const busy = reduce(undefined, "UserPromptSubmit", at) as AgentState;

  it("gives a waiting state a longer grace than an active one", () => {
    expect(isAgentStateStale(busy, at + AGENT_ACTIVE_STALE_MS)).toBe(true);
    expect(isAgentStateStale(waiting, at + AGENT_ACTIVE_STALE_MS)).toBe(false);
    expect(isAgentStateStale(waiting, at + AGENT_WAITING_STALE_MS)).toBe(true);
  });

  it("never calls an idle state stale", () => {
    const idle = reduce(undefined, "Stop", at) as AgentState;

    expect(isAgentStateStale(idle, at + AGENT_STATE_TTL_MS)).toBe(false);
  });
});
