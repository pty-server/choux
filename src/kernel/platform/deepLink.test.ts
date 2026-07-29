import { describe, expect, it } from "vitest";
import { parseSessionDeepLink } from "./deepLink";

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
