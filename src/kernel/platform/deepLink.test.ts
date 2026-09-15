import { describe, expect, it } from "vitest";
import { parseSessionDeepLink, serverForDeepLink } from "./deepLink";

describe("serverForDeepLink", () => {
  const server = (id: string, serverId: string | undefined, status: string, sessionIds: string[] = []) => ({
    config: { id, serverId },
    status,
    sessions: sessionIds.map((sessionId) => ({ id: sessionId })),
  });
  const link = { serverId: "shared", sessionId: "s2" };

  it("prefers the connection that has the session when several share a server identity", () => {
    const servers = [server("a", "shared", "online", ["s1"]), server("b", "shared", "offline", ["s2"])];

    expect(serverForDeepLink(servers, link)?.config.id).toBe("b");
  });

  it("falls back to an online connection, then to the first one sharing the identity", () => {
    expect(serverForDeepLink([server("a", "shared", "offline"), server("b", "shared", "online")], link)?.config.id).toBe("b");
    expect(serverForDeepLink([server("a", "shared", "offline"), server("b", "shared", "offline")], link)?.config.id).toBe("a");
  });

  it("accepts this install's own config id and reports an unknown server", () => {
    const servers = [server("config-1", "other", "online")];

    expect(serverForDeepLink(servers, { serverId: "config-1", sessionId: "s1" })?.config.id).toBe("config-1");
    expect(serverForDeepLink(servers, link)).toBeUndefined();
  });
});

describe("session deep links", () => {
  it("parses the supported session focus link", () => {
    expect(parseSessionDeepLink("choux://server/server-id/session/session-id")).toEqual({
      serverId: "server-id",
      sessionId: "session-id",
    });
  });

  it.each([
    "https://server/server-id/session/session-id",
    "choux://server/server-id/session",
    "choux://server/server-id/session/session-id?token=secret",
    "choux://workspace/server-id/session/session-id",
    "not a url",
  ])("rejects unsupported input: %s", (value) => {
    expect(parseSessionDeepLink(value)).toBeUndefined();
  });
});
