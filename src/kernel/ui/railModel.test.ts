import { PROTOCOL_VERSION, type ServerInfo, type Session, type Workspace } from "@pty-server/protocol";
import { describe, expect, it } from "vitest";
import type { ServerConn, ServerStatus } from "../../registry/types";
import { buildRailModel, tileStatus, workspaceCloseBlocker } from "./railModel";

function info(protocolMinor: number): ServerInfo {
  return { version: "0.0.0", protocol: PROTOCOL_VERSION, protocolMinor, serverId: "s", uptime: 0, sessions: 0, user: "u", workspaces: 0 };
}

function session(id: string, workspaceId: string, exited: boolean): Session {
  return {
    id,
    workspaceId,
    cmd: "sh",
    args: [],
    env: {},
    cols: 80,
    rows: 24,
    createdAt: 1,
    pid: 1,
    cwd: "/",
    ...(exited ? { exited: { code: 0, at: 2 } } : {}),
  };
}

function workspace(id: string, kind: Workspace["kind"] = "project"): Workspace {
  return { id, kind, name: id, path: `/workspaces/${id}`, realpath: `/workspaces/${id}`, createdAt: 1 };
}

function server(id: string, label: string, status: ServerStatus, workspaces: Workspace[], sessions: Session[] = [], accent = "#000"): ServerConn {
  return {
    config: { id, label, accent, url: `http://${id}.test`, tokenRef: `${id}-token` },
    status,
    info: undefined,
    workspaces,
    sessions,
    terminalTitles: {},
    agentStates: {},
  };
}

describe("buildRailModel", () => {
  it("groups tiles by server in registry and workspace order", () => {
    const model = buildRailModel([
      server("one", "One", "online", [workspace("a"), workspace("b")], [], "#f00"),
      server("empty", "Empty", "offline", []),
      server("two", "Two", "connecting", [workspace("c")], [], "#0f0"),
    ]);

    expect(model.groups.map((group) => group.serverId)).toEqual(["one", "two"]);
    expect(model.groups[0].tiles.map((tile) => tile.key)).toEqual(["one:a", "one:b"]);
    expect(model.groups[1].tiles.map((tile) => tile.key)).toEqual(["two:c"]);
    expect(model.groups[0].tiles.map((tile) => tile.accent)).toEqual(["#f00", "#f00"]);
    expect(model.groups[1].tiles[0].accent).toBe("#0f0");
    expect(model.showDividers).toBe(true);
  });

  it("separates runners from projects within a server, keeping each in workspace order", () => {
    const model = buildRailModel([
      server("one", "One", "online", [workspace("r1", "runner"), workspace("p1"), workspace("r2", "runner"), workspace("p2")]),
      server("two", "Two", "online", [workspace("r3", "runner")]),
    ]);

    expect(model.groups[0].tiles.map((tile) => tile.key)).toEqual(["one:p1", "one:p2"]);
    expect(model.groups[0].runners.map((tile) => tile.key)).toEqual(["one:r1", "one:r2"]);
    expect(model.groups[1].tiles).toEqual([]);
    expect(model.groups[1].runners.map((tile) => tile.key)).toEqual(["two:r3"]);
  });

  it("does not show dividers for one server", () => {
    const model = buildRailModel([server("one", "One", "online", [workspace("a")])]);

    expect(model.groups).toHaveLength(1);
    expect(model.showDividers).toBe(false);
  });

  it("returns no groups or dividers with no servers", () => {
    const model = buildRailModel([]);

    expect(model.groups).toEqual([]);
    expect(model.showDividers).toBe(false);
  });

  it("marks each tile with whether its workspace can be closed", () => {
    const model = buildRailModel([{
      ...server("one", "One", "online", [workspace("idle"), workspace("busy", "runner")], [session("s1", "busy", false)]),
      info: info(2),
    }]);

    expect(model.groups[0].tiles[0].closeBlocker).toBeUndefined();
    expect(model.groups[0].runners[0].closeBlocker).toBeDefined();
  });

  it("maps every server status to a tile status", () => {
    expect(tileStatus("connecting")).toBe("warn");
    expect(tileStatus("online")).toBe("online");
    expect(tileStatus("offline")).toBe("offline");
    expect(tileStatus("unauthorized")).toBe("offline");
    expect(tileStatus("version-mismatch")).toBe("offline");
  });
});

describe("workspaceCloseBlocker", () => {
  const target = workspace("target");
  const online = (sessions: Session[], minor = 2): ServerConn => ({ ...server("one", "One", "online", [target, workspace("other")], sessions), info: info(minor) });

  it("allows closing a workspace with no sessions or only exited ones", () => {
    expect(workspaceCloseBlocker(online([]), target)).toBeUndefined();
    expect(workspaceCloseBlocker(online([session("s1", "target", true)]), target)).toBeUndefined();
  });

  it("ignores running sessions that belong to another workspace", () => {
    expect(workspaceCloseBlocker(online([session("s1", "other", false)]), target)).toBeUndefined();
  });

  it("refuses while a session in the workspace is running", () => {
    expect(workspaceCloseBlocker(online([session("s1", "target", true), session("s2", "target", false)]), target)).toMatch(/running sessions/);
  });

  it("refuses on a server that predates workspace deletion or has not reported its protocol", () => {
    expect(workspaceCloseBlocker(online([], 1), target)).toMatch(/Upgrade ptys/);
    expect(workspaceCloseBlocker({ ...online([]), info: undefined }, target)).toMatch(/Upgrade ptys/);
  });

  it("refuses while the server is not connected", () => {
    expect(workspaceCloseBlocker({ ...online([]), status: "offline" }, target)).toMatch(/not connected/);
  });
});
