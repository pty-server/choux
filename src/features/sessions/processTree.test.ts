import { describe, expect, it } from "vitest";
import { parseProcessRows, subtreeAgents } from "./processTree";

const listing = [
  "  1000     999 zsh",
  "  1001    1000 claude",
  "  1002    1001 2.1.234",
  "  2000    1999 bash",
  "  2001    2000 nvim",
  "  3000    2999 opencode",
].join("\n");

describe("parseProcessRows", () => {
  it("reads pid, ppid and command from ps output", () => {
    expect(parseProcessRows("  1000     999 zsh\n")).toEqual([{ pid: "1000", ppid: "999", command: "zsh" }]);
  });

  it("keeps a command that carries spaces", () => {
    expect(parseProcessRows("1 0 Google Chrome")[0]?.command).toBe("Google Chrome");
  });

  it("skips blank and truncated lines", () => {
    expect(parseProcessRows("\n1000 999\n1001 1000 claude\n")).toEqual([
      { pid: "1001", ppid: "1000", command: "claude" },
    ]);
  });
});

describe("subtreeAgents", () => {
  const rows = parseProcessRows(listing);

  it("finds an agent running below the pane's shell", () => {
    expect(subtreeAgents(rows, ["1000"])).toEqual({ "1000": "Claude Code" });
  });

  it("finds an agent that is the pane process itself", () => {
    expect(subtreeAgents(rows, ["3000"])).toEqual({ "3000": "OpenCode" });
  });

  it("reports nothing for a pane whose tree holds no agent", () => {
    expect(subtreeAgents(rows, ["2000"])).toEqual({});
  });

  it("ignores an agent's renamed children, which carry its version string", () => {
    expect(subtreeAgents(rows, ["1002"])).toEqual({});
  });

  it("ignores a pane with no pid", () => {
    expect(subtreeAgents(rows, [""])).toEqual({});
  });

  it("survives a parent cycle in the listing", () => {
    const cyclic = parseProcessRows("10 11 bash\n11 10 bash\n");

    expect(subtreeAgents(cyclic, ["10"])).toEqual({});
  });
});
