import { beforeEach, describe, expect, it } from "vitest";
import type { AgentState } from "../../registry/types";
import {
  INTEGRATION_HINT_DELAY_MS,
  clearAgentSighting,
  dismissIntegrationHint,
  hintKey,
  integrationInstall,
  isIntegrationHintDismissed,
  resetIntegrationHints,
  shouldHintMissingIntegration,
  trackAgentSighting,
} from "./integrationHint";

function state(overrides: Partial<AgentState> = {}): AgentState {
  return { agent: "claude-code", activity: "idle", sessionId: "s1", subagents: 0, updatedAt: 1, ...overrides };
}

beforeEach(() => {
  resetIntegrationHints();
});

describe("shouldHintMissingIntegration", () => {
  const seen = { agent: "claude", firstSeenAt: 0, dismissed: false } as const;

  it("waits out the grace period before accusing anything", () => {
    expect(shouldHintMissingIntegration({ ...seen, now: INTEGRATION_HINT_DELAY_MS - 1 })).toBe(false);
    expect(shouldHintMissingIntegration({ ...seen, now: INTEGRATION_HINT_DELAY_MS })).toBe(true);
  });

  it("stays quiet once the reporter has sent anything", () => {
    expect(shouldHintMissingIntegration({ ...seen, state: state(), now: INTEGRATION_HINT_DELAY_MS })).toBe(false);
  });

  it("stays quiet for a session running no known agent", () => {
    expect(shouldHintMissingIntegration({ ...seen, agent: undefined, now: INTEGRATION_HINT_DELAY_MS })).toBe(false);
  });

  it("stays quiet once dismissed", () => {
    expect(shouldHintMissingIntegration({ ...seen, dismissed: true, now: INTEGRATION_HINT_DELAY_MS })).toBe(false);
  });

  it("stays quiet until the session has been seen at all", () => {
    expect(shouldHintMissingIntegration({ ...seen, firstSeenAt: undefined, now: INTEGRATION_HINT_DELAY_MS })).toBe(false);
  });
});

describe("sighting tracker", () => {
  it("keeps the first sighting across repeated reports", () => {
    const key = hintKey("server", "session");
    expect(trackAgentSighting(key, 1_000)).toBe(1_000);
    expect(trackAgentSighting(key, 9_000)).toBe(1_000);
  });

  it("restarts the wait once the sighting is cleared", () => {
    const key = hintKey("server", "session");
    trackAgentSighting(key, 1_000);
    clearAgentSighting(key);
    expect(trackAgentSighting(key, 9_000)).toBe(9_000);
  });

  it("tracks each session on each server separately", () => {
    trackAgentSighting(hintKey("a", "session"), 1_000);
    expect(trackAgentSighting(hintKey("b", "session"), 9_000)).toBe(9_000);
  });
});

describe("dismissal", () => {
  it("remembers only the dismissed session", () => {
    dismissIntegrationHint(hintKey("server", "one"));
    expect(isIntegrationHintDismissed(hintKey("server", "one"))).toBe(true);
    expect(isIntegrationHintDismissed(hintKey("server", "two"))).toBe(false);
  });
});

describe("integrationInstall", () => {
  it("gives Claude Code the plugin commands", () => {
    const install = integrationInstall("claude");
    expect(install.label).toBe("Claude Code");
    expect(install.command).toContain("claude plugin install choux@pty-server");
  });

  it("sends the agents without an installer to the docs", () => {
    for (const agent of ["codex", "opencode"] as const) {
      const install = integrationInstall(agent);
      expect(install.command).toBeUndefined();
      expect(install.docs).toContain("integrations/README.md");
    }
  });
});
