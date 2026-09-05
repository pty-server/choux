import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../storage/serverConfigStore";
import { canAttach, credentialFor, credentialKey } from "./serverCredential";

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "server-a",
    label: "A",
    accent: "#4C6EF5",
    url: "https://a.example",
    auth: "token",
    tokenRef: "server-a",
    ...overrides,
  };
}

describe("credentialFor", () => {
  const configA = serverConfig();
  const credentialA = { key: credentialKey(configA), token: "token-a" };

  it("hands back the token resolved for this very server", () => {
    expect(credentialFor(credentialA, configA)).toBe("token-a");
  });

  it("withholds another server's token", () => {
    const configB = serverConfig({ id: "server-b", url: "https://b.example", tokenRef: "server-b" });
    expect(credentialFor(credentialA, configB)).toBeUndefined();
  });

  it("withholds a token resolved from a since-replaced tokenRef", () => {
    expect(credentialFor(credentialA, serverConfig({ tokenRef: "server-a-rotated" }))).toBeUndefined();
  });

  it("has nothing to hand back before a lookup lands", () => {
    expect(credentialFor(undefined, configA)).toBeUndefined();
  });
});

describe("canAttach", () => {
  it("waits for the matching credential on a token server", () => {
    const config = serverConfig();
    expect(canAttach(undefined, config)).toBe(false);
    expect(canAttach({ key: credentialKey(serverConfig({ id: "other" })), token: "token-a" }, config)).toBe(false);
    expect(canAttach({ key: credentialKey(config), token: "token-a" }, config)).toBe(true);
  });

  it("attaches straight away when the server takes no token", () => {
    expect(canAttach(undefined, serverConfig({ auth: "none" }))).toBe(true);
    expect(canAttach(undefined, serverConfig({ transport: "local", instance: "default" }))).toBe(true);
  });

  it("cannot attach without a server", () => {
    expect(canAttach(undefined, undefined)).toBe(false);
  });
});
