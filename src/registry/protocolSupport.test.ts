import { PROTOCOL_MINOR, PROTOCOL_VERSION } from "@pty-server/protocol";
import { describe, expect, it } from "vitest";
import { incompatibleServerMessage, runnerSupport } from "./protocolSupport";

describe("runnerSupport", () => {
  it("is unknown until the server info has been read", () => {
    expect(runnerSupport(undefined)).toBeUndefined();
  });

  it("treats a server without protocolMinor as legacy", () => {
    expect(runnerSupport({ protocol: PROTOCOL_VERSION })).toBe("legacy");
  });

  it("supports runners from the minor that introduced them", () => {
    expect(runnerSupport({ protocol: PROTOCOL_VERSION, protocolMinor: PROTOCOL_MINOR })).toBe("supported");
    expect(runnerSupport({ protocol: PROTOCOL_VERSION, protocolMinor: PROTOCOL_MINOR + 1 })).toBe("supported");
  });

  it("is incompatible on a different major at any minor", () => {
    expect(runnerSupport({ protocol: PROTOCOL_VERSION + 1, protocolMinor: PROTOCOL_MINOR })).toBe("incompatible");
    expect(runnerSupport({ protocol: PROTOCOL_VERSION - 1 })).toBe("incompatible");
  });
});

describe("incompatibleServerMessage", () => {
  it("names both versions and asks to upgrade the older server", () => {
    const message = incompatibleServerMessage({ protocol: PROTOCOL_VERSION - 1 });
    expect(message).toContain(`${PROTOCOL_VERSION - 1}.0`);
    expect(message).toContain(`${PROTOCOL_VERSION}.${PROTOCOL_MINOR}`);
    expect(message).toContain("Upgrade ptys");
  });

  it("asks to upgrade Choux for a newer server", () => {
    expect(incompatibleServerMessage({ protocol: PROTOCOL_VERSION + 1, protocolMinor: 3 })).toContain("Upgrade Choux");
  });
});
