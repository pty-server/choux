import { PROTOCOL_VERSION, type ServerInfo } from "@pty-server/protocol";
import { describe, expect, it } from "vitest";
import type { ServerConn, ServerStatus } from "../../registry/types";
import { sessionMoveBlocker } from "./sessionMove";

function server(status: ServerStatus, protocolMinor: number | undefined): ServerConn {
  const info: ServerInfo | undefined = protocolMinor === undefined
    ? undefined
    : { version: "0.0.0", protocol: PROTOCOL_VERSION, protocolMinor, serverId: "s", uptime: 0, sessions: 0, user: "u", workspaces: 0 };
  return {
    config: { id: "one", label: "One", accent: "#000", url: "http://one.test", tokenRef: "one-token" },
    status,
    info,
    workspaces: [],
    sessions: [],
    terminalTitles: {},
    agentStates: {},
  };
}

describe("sessionMoveBlocker", () => {
  it("allows moving on a connected server that supports it", () => {
    expect(sessionMoveBlocker(server("online", 3))).toBeUndefined();
  });

  it("refuses while no server is selected or it is not connected", () => {
    expect(sessionMoveBlocker(undefined)).toMatch(/not connected/);
    expect(sessionMoveBlocker(server("offline", 3))).toMatch(/not connected/);
  });

  it("refuses on a server that predates moving sessions or has not reported its protocol", () => {
    expect(sessionMoveBlocker(server("online", 2))).toMatch(/Upgrade ptys/);
    expect(sessionMoveBlocker(server("online", undefined))).toMatch(/Upgrade ptys/);
  });
});
