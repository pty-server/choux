import { describe, expect, it } from "vitest";
import { parsePanes, parseTty, parseWindows, sessionNameForTty, windowDetail, type TmuxWindow } from "./tmuxParse";

function window(overrides: Partial<TmuxWindow> = {}): TmuxWindow {
  return { id: "@1", index: "0", name: "editor", active: false, command: "nvim", paneTitle: "", ...overrides };
}

describe("parseTty", () => {
  it("reads the bare device from ps output", () => {
    expect(parseTty("pts/5\n")).toBe("pts/5");
  });

  it("strips a /dev prefix", () => {
    expect(parseTty("/dev/pts/5\n")).toBe("pts/5");
  });

  it("returns undefined when the process has no controlling terminal", () => {
    expect(parseTty("?\n")).toBeUndefined();
  });

  it("returns undefined for empty output", () => {
    expect(parseTty("")).toBeUndefined();
  });
});

describe("sessionNameForTty", () => {
  const clients = "/dev/pts/3\tother\n/dev/pts/5\tscratch\n";

  it("matches a client across the /dev prefix mismatch", () => {
    expect(sessionNameForTty(clients, "pts/5")).toBe("scratch");
  });

  it("matches when both sides carry the prefix", () => {
    expect(sessionNameForTty(clients, "/dev/pts/3")).toBe("other");
  });

  it("returns undefined when no client holds that tty", () => {
    expect(sessionNameForTty(clients, "pts/9")).toBeUndefined();
  });

  it("returns undefined for empty output", () => {
    expect(sessionNameForTty("", "pts/5")).toBeUndefined();
  });

  it("ignores lines without a session name", () => {
    expect(sessionNameForTty("/dev/pts/5\n", "pts/5")).toBeUndefined();
  });
});

describe("parseWindows", () => {
  it("parses a listing and marks the active window", () => {
    const stdout = "@1\t0\teditor\t1\tnvim\tnvim src/main.ts\n@2\t1\tserver\t0\tnpm\tnpm run dev\n";

    expect(parseWindows(stdout)).toEqual([
      { id: "@1", index: "0", name: "editor", active: true, command: "nvim", paneTitle: "nvim src/main.ts" },
      { id: "@2", index: "1", name: "server", active: false, command: "npm", paneTitle: "npm run dev" },
    ]);
  });

  it("keeps a tab inside the pane title, which is arbitrary program-set text", () => {
    expect(parseWindows("@1\t0\teditor\t1\tnvim\tone\ttwo\n")).toEqual([
      { id: "@1", index: "0", name: "editor", active: true, command: "nvim", paneTitle: "one\ttwo" },
    ]);
  });

  it("tolerates a missing pane command and title", () => {
    expect(parseWindows("@1\t0\tshell\t1\n")).toEqual([
      { id: "@1", index: "0", name: "shell", active: true, command: "", paneTitle: "" },
    ]);
  });

  it("skips malformed lines", () => {
    expect(parseWindows("garbage\n@1\t0\tshell\t1\tzsh\tzsh\n")).toEqual([
      { id: "@1", index: "0", name: "shell", active: true, command: "zsh", paneTitle: "zsh" },
    ]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseWindows("")).toEqual([]);
  });
});

describe("windowDetail", () => {
  it("prefers the pane title over the process name", () => {
    expect(windowDetail(window({ paneTitle: "nvim src/main.ts" }))).toBe("nvim src/main.ts");
  });

  it("falls back to the command when no title is set", () => {
    expect(windowDetail(window({ paneTitle: "" }))).toBe("nvim");
  });

  it("drops a title that only repeats the window name", () => {
    expect(windowDetail(window({ name: "bash", command: "bash", paneTitle: "bash" }))).toBe("");
  });

  it("drops a repeat regardless of case or padding", () => {
    expect(windowDetail(window({ name: "Bash", command: "bash", paneTitle: " BASH " }))).toBe("");
  });

  it("returns nothing when neither title nor command is set", () => {
    expect(windowDetail(window({ command: "", paneTitle: "" }))).toBe("");
  });

  it("keeps the active window's detail, which the session row does not always carry", () => {
    expect(windowDetail(window({ active: true, paneTitle: "* detect-session-views" }))).toBe("* detect-session-views");
  });
});

describe("parsePanes", () => {
  it("maps every pane to its window and command", () => {
    expect(parsePanes("%1\t@0\tbash\n%2\t@0\tclaude\n%3\t@1\tnvim\n")).toEqual([
      { id: "%1", windowId: "@0", command: "bash" },
      { id: "%2", windowId: "@0", command: "claude" },
      { id: "%3", windowId: "@1", command: "nvim" },
    ]);
  });

  it("keeps a pane whose command is empty", () => {
    expect(parsePanes("%1\t@0\t")).toEqual([{ id: "%1", windowId: "@0", command: "" }]);
  });

  it("skips blank and truncated lines", () => {
    expect(parsePanes("\n%1\n%2\t@0\tbash\n")).toEqual([{ id: "%2", windowId: "@0", command: "bash" }]);
  });

  it("returns nothing for empty output", () => {
    expect(parsePanes("")).toEqual([]);
  });
});
