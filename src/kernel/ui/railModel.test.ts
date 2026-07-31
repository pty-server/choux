import type { Session, Workspace } from "@pty-server/protocol";
import { describe, expect, it } from "vitest";
import type { ServerConn, ServerStatus } from "../../registry/types";
import { buildRailModel, tileStatus } from "./railModel";

function workspace(id: string): Workspace {
  return { id, path: `/workspaces/${id}`, realpath: `/workspaces/${id}`, createdAt: 1 };
}

function session(id: string, workspaceId: string, exited?: Session["exited"]): Session {
  return {
    id,
    workspaceId,
    cmd: "sh",
    args: [],
    env: {},
    cols: 80,
    rows: 24,
    createdAt: 1,
    pid: 100,
    cwd: `/workspaces/${workspaceId}`,
    exited,
  };
}

function server(id: string, label: string, status: ServerStatus, workspaces: Workspace[], sessions: Session[] = [], accent = "#000"): ServerConn {
  return {
    config: { id, label, accent, url: `http://${id}.test`, tokenRef: `${id}-token` },
    status,
    info: undefined,
    workspaces,
    sessions,
    terminalTitles: {},
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

  it("counts only non-zero exited sessions in each workspace", () => {
    const model = buildRailModel([
      server("one", "One", "online", [workspace("a"), workspace("b")], [
        session("non-zero-one", "a", { code: 1, at: 1 }),
        session("non-zero-two", "a", { code: 2, at: 1 }),
        session("zero", "a", { code: 0, at: 1 }),
        session("live", "a"),
        session("other-workspace", "b", { code: 3, at: 1 }),
      ]),
    ]);

    expect(model.groups[0].tiles[0].exitBadgeCount).toBe(2);
    expect(model.groups[0].tiles[1].exitBadgeCount).toBe(1);
  });
});
