import type { Session } from "@pty-server/protocol";
import { describe, expect, it } from "vitest";
import type { AgentState } from "../../registry/types";
import { agentStateKey } from "../../registry/agentStateKey";
import { integrationRows, integrationStatusLabel } from "./integrationStatus";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    workspaceId: "w1",
    cmd: "sh",
    args: [],
    env: {},
    cols: 80,
    rows: 24,
    createdAt: 1,
    pid: 100,
    cwd: "/w",
    ...overrides,
  };
}

function state(sessionId: string, overrides: Partial<AgentState> = {}): AgentState {
  return { agent: "claude-code", activity: "idle", sessionId, subagents: 0, updatedAt: 1, ...overrides };
}

function rowFor(servers: Parameters<typeof integrationRows>[0], agent: string) {
  const row = integrationRows(servers).find((candidate) => candidate.agent === agent);
  if (row === undefined) throw new Error(`no row for ${agent}`);
  return row;
}

describe("integrationRows", () => {
  it("lists every known agent even with no servers connected", () => {
    expect(integrationRows([]).map((row) => row.agent)).toEqual(["claude", "codex", "opencode"]);
  });

  it("reports no sessions when nothing runs an agent", () => {
    const row = rowFor([{ sessions: [session()], agentStates: {} }], "claude");
    expect(row.status).toBe("absent");
    expect(row.sessions).toBe(0);
  });

  it("reports silence when an agent runs but never sent state", () => {
    const row = rowFor([{ sessions: [session({ process: "claude" })], agentStates: {} }], "claude");
    expect(row.status).toBe("silent");
    expect(row.sessions).toBe(1);
    expect(row.reporting).toBe(0);
  });

  it("reports the integration working once state arrives", () => {
    const row = rowFor(
      [{ sessions: [session({ process: "claude" })], agentStates: { [agentStateKey("s1", undefined)]: state("s1") } }],
      "claude",
    );
    expect(row.status).toBe("reporting");
    expect(row.reporting).toBe(1);
  });

  it("counts a partially installed fleet as reporting but not complete", () => {
    const row = rowFor(
      [
        { sessions: [session({ id: "a", process: "claude" })], agentStates: { [agentStateKey("a", undefined)]: state("a") } },
        { sessions: [session({ id: "b", process: "claude" })], agentStates: {} },
      ],
      "claude",
    );
    expect(row.sessions).toBe(2);
    expect(row.reporting).toBe(1);
    expect(row.status).toBe("reporting");
  });

  it("counts a tmux session the process list hides but the reporter names", () => {
    const row = rowFor(
      [{ sessions: [session({ process: "tmux" })], agentStates: { [agentStateKey("s1", "%0")]: state("s1") } }],
      "claude",
    );
    expect(row.sessions).toBe(1);
    expect(row.reporting).toBe(1);
    expect(row.status).toBe("reporting");
  });

  it("counts one session once when both the process and the reporter name it", () => {
    const row = rowFor(
      [{ sessions: [session({ process: "claude" })], agentStates: { [agentStateKey("s1", undefined)]: state("s1") } }],
      "claude",
    );
    expect(row.sessions).toBe(1);
    expect(row.reporting).toBe(1);
  });

  it("ignores state from an agent it has no row for", () => {
    const rows = integrationRows([{ sessions: [], agentStates: { "session:s1": state("s1", { agent: "gemini" }) } }]);
    expect(rows.every((row) => row.status === "absent")).toBe(true);
  });

  it("keeps agents apart", () => {
    const servers = [{ sessions: [session({ process: "codex" })], agentStates: {} }];
    expect(rowFor(servers, "codex").status).toBe("silent");
    expect(rowFor(servers, "claude").status).toBe("absent");
  });

  it("carries the plugin command for Claude Code and docs for the rest", () => {
    expect(rowFor([], "claude").command).toContain("claude plugin install choux@pty-server");
    expect(rowFor([], "codex").command).toBeUndefined();
    expect(rowFor([], "codex").docs).toContain("integrations/README.md");
  });
});

describe("integrationStatusLabel", () => {
  it("names each status", () => {
    expect(integrationStatusLabel("reporting")).toBe("Reporting");
    expect(integrationStatusLabel("silent")).toBe("Not reporting");
    expect(integrationStatusLabel("absent")).toBe("No sessions");
  });
});
