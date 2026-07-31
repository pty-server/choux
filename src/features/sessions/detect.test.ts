import type { Session } from "@pty-server/protocol";
import { describe, expect, it } from "vitest";
import { agentLabelFor, detectAgent } from "./agentDetect";
import { isTmuxSession } from "./tmuxDetect";

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

describe("isTmuxSession", () => {
  it("detects tmux typed into a plain shell", () => {
    expect(isTmuxSession(session({ cmd: "/bin/zsh", process: "tmux" }))).toBe(true);
  });

  it("detects a session ptys spawned as tmux", () => {
    expect(isTmuxSession(session({ cmd: "tmux", args: ["new-session", "-A", "-s", "main"] }))).toBe(true);
  });

  it("resolves an absolute path to its binary name", () => {
    expect(isTmuxSession(session({ cmd: "/opt/homebrew/bin/tmux" }))).toBe(true);
  });

  it("prefers the live foreground process over the spawned command", () => {
    expect(isTmuxSession(session({ cmd: "tmux", process: "vim" }))).toBe(false);
  });

  it("ignores an exited session, whose foreground process is gone", () => {
    expect(isTmuxSession(session({ cmd: "tmux", exited: { code: 0, at: 2 } }))).toBe(false);
  });

  it("ignores a plain shell", () => {
    expect(isTmuxSession(session({ cmd: "/bin/bash", process: "bash" }))).toBe(false);
  });
});

describe("detectAgent", () => {
  it("detects an agent from the live foreground process", () => {
    expect(detectAgent(session({ cmd: "/bin/zsh", process: "claude" }))).toBe("Claude Code");
  });

  it("detects an agent from the spawned command when process reports the runtime", () => {
    expect(detectAgent(session({ cmd: "opencode", process: "node" }))).toBe("OpenCode");
  });

  it("detects an agent passed as the first argument", () => {
    expect(detectAgent(session({ cmd: "/usr/bin/env", args: ["codex"], process: "node" }))).toBe("Codex");
  });

  it("ignores an exited session", () => {
    expect(detectAgent(session({ cmd: "claude", exited: { code: 0, at: 2 } }))).toBeUndefined();
  });

  it("ignores an unrelated session", () => {
    expect(detectAgent(session({ cmd: "/bin/bash", process: "bash" }))).toBeUndefined();
  });
});

describe("agentLabelFor", () => {
  it("labels a bare command", () => {
    expect(agentLabelFor("claude")).toBe("Claude Code");
  });

  it("resolves an absolute path to its binary name", () => {
    expect(agentLabelFor("/usr/local/bin/codex")).toBe("Codex");
  });

  it("returns undefined for a missing or unrelated command", () => {
    expect(agentLabelFor(undefined)).toBeUndefined();
    expect(agentLabelFor("")).toBeUndefined();
    expect(agentLabelFor("bash")).toBeUndefined();
  });
});
