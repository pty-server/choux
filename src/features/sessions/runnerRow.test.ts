import { describe, expect, it } from "vitest";
import { formatDuration, runnerStartCommand, sessionLocation, sessionState } from "./runnerRow";

describe("sessionLocation", () => {
  it("shows the workspace root as a dot", () => {
    expect(sessionLocation({ cwd: "/src/shop" }, "/src/shop")).toBe(".");
  });

  it("shows a directory below the root relative to it", () => {
    expect(sessionLocation({ cwd: "/src/shop/packages/web" }, "/src/shop")).toBe("packages/web");
  });

  it("shows a directory outside the root as an absolute path", () => {
    expect(sessionLocation({ cwd: "/tmp/scratch" }, "/src/shop")).toBe("/tmp/scratch");
  });
});

describe("formatDuration", () => {
  it("rounds down to whole minutes, hours and days", () => {
    expect(formatDuration(-5)).toBe("<1m");
    expect(formatDuration(59_999)).toBe("<1m");
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration((2 * 60 + 5) * 60_000)).toBe("2h 5m");
    expect(formatDuration((3 * 24 + 4) * 3_600_000)).toBe("3d 4h");
  });
});

describe("sessionState", () => {
  it("shows uptime for a running session", () => {
    expect(sessionState({ createdAt: 0 }, 7 * 60_000)).toBe("up 7m");
  });

  it("shows the exit code, and the signal when there is one", () => {
    expect(sessionState({ createdAt: 0, exited: { code: 0, at: 1 } }, 10)).toBe("exit 0");
    expect(sessionState({ createdAt: 0, exited: { code: 1, signal: 9, at: 1 } }, 10)).toBe("exit 1, signal 9");
  });
});

describe("runnerStartCommand", () => {
  it("uses a plain workspace name as is", () => {
    expect(runnerStartCommand("shop")).toBe("ptys start --workspace shop npm run dev");
  });

  it("quotes a name the shell would split or expand", () => {
    expect(runnerStartCommand("shop stack")).toBe("ptys start --workspace 'shop stack' npm run dev");
    expect(runnerStartCommand("it's $HOME")).toBe("ptys start --workspace 'it'\\''s $HOME' npm run dev");
  });
});
