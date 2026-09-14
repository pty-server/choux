import type { Session, Workspace } from "@pty-server/protocol";
import { describe, expect, it } from "vitest";
import type { ServerConn, ServerStatus } from "../../registry/types";
import { buildRailModel, tileStatus } from "./railModel";

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

  it("maps every server status to a tile status", () => {
    expect(tileStatus("connecting")).toBe("warn");
    expect(tileStatus("online")).toBe("online");
    expect(tileStatus("offline")).toBe("offline");
    expect(tileStatus("unauthorized")).toBe("offline");
    expect(tileStatus("version-mismatch")).toBe("offline");
  });
});
