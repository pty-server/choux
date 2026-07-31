import { describe, expect, it } from "vitest";
import type { AgentState } from "../../registry/types";
import { activityDetail, activityLabel, activityTitle } from "./agentActivity";

function state(overrides: Partial<AgentState> = {}): AgentState {
  return { agent: "claude-code", activity: "idle", sessionId: "s1", subagents: 0, updatedAt: 1, ...overrides };
}

describe("activityLabel", () => {
  it("names each activity", () => {
    expect(activityLabel(state({ activity: "idle" }))).toBe("Idle");
    expect(activityLabel(state({ activity: "busy" }))).toBe("Working");
    expect(activityLabel(state({ activity: "waiting" }))).toBe("Awaiting approval");
    expect(activityLabel(state({ activity: "compacting" }))).toBe("Compacting");
  });

  it("names the running tool", () => {
    expect(activityLabel(state({ activity: "tool", tool: "Bash" }))).toBe("Running Bash");
  });

  it("falls back when a tool event carried no tool name", () => {
    expect(activityLabel(state({ activity: "tool" }))).toBe("Working");
  });

  it("counts subagents, singular and plural", () => {
    expect(activityLabel(state({ activity: "busy", subagents: 1 }))).toBe("Working, 1 subagent");
    expect(activityLabel(state({ activity: "busy", subagents: 3 }))).toBe("Working, 3 subagents");
  });
});

describe("activityDetail", () => {
  it("spells out only what the icon cannot show", () => {
    expect(activityDetail(state({ activity: "idle" }))).toBe("");
    expect(activityDetail(state({ activity: "busy" }))).toBe("");
    expect(activityDetail(state({ activity: "waiting" }))).toBe("");
    expect(activityDetail(state({ activity: "tool", tool: "Bash" }))).toBe("Bash");
  });

  it("appends a subagent count", () => {
    expect(activityDetail(state({ activity: "tool", tool: "Task", subagents: 2 }))).toBe("Task +2");
    expect(activityDetail(state({ activity: "busy", subagents: 2 }))).toBe("+2");
  });
});

describe("activityTitle", () => {
  it("appends the message when there is one", () => {
    expect(activityTitle(state({ activity: "waiting", message: "Allow Bash?" }))).toBe("Awaiting approval - Allow Bash?");
  });

  it("falls back to the detail", () => {
    expect(activityTitle(state({ activity: "tool", tool: "Bash", detail: "npm test" }))).toBe("Running Bash - npm test");
  });

  it("is just the label when there is neither", () => {
    expect(activityTitle(state({ activity: "idle" }))).toBe("Idle");
  });
});
