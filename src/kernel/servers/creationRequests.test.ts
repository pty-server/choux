import { PROTOCOL_MINOR, PROTOCOL_VERSION } from "@pty-server/protocol";
import { describe, expect, it } from "vitest";
import { gateSessionRequest, gateWorkspaceRequest } from "./creationRequests";

const supported = { protocol: PROTOCOL_VERSION, protocolMinor: PROTOCOL_MINOR };
const legacy = { protocol: PROTOCOL_VERSION };
const incompatible = { protocol: PROTOCOL_VERSION + 1 };

const session = { workspaceId: "w1", cmd: "npm", args: ["run", "dev"], cols: 80, rows: 24 };

describe("gateSessionRequest", () => {
  it("carries cwd to a server that supports runners", () => {
    expect(gateSessionRequest({ ...session, cwd: "packages/web" }, supported)).toEqual({ body: { ...session, cwd: "packages/web" } });
  });

  it("omits an empty cwd so the server uses the workspace root", () => {
    expect(gateSessionRequest({ ...session, cwd: "" }, supported)).toEqual({ body: session });
  });

  it("never sends cwd to a legacy server or one whose level is unknown", () => {
    expect(gateSessionRequest({ ...session, cwd: "/tmp" }, legacy)).toEqual({ body: session });
    expect(gateSessionRequest({ ...session, cwd: "/tmp" }, undefined)).toEqual({ body: session });
  });

  it("refuses an incompatible server", () => {
    const gated = gateSessionRequest(session, incompatible);
    expect("refusal" in gated && gated.refusal).toContain(`${PROTOCOL_VERSION + 1}.0`);
  });
});

describe("gateWorkspaceRequest", () => {
  it("carries kind and name to a server that supports runners", () => {
    expect(gateWorkspaceRequest({ path: "/src/shop", kind: "runner", name: "stack" }, supported))
      .toEqual({ body: { path: "/src/shop", kind: "runner", name: "stack" } });
  });

  it("omits an empty name so the server derives it", () => {
    expect(gateWorkspaceRequest({ path: "/src/shop", kind: "project", name: "" }, supported))
      .toEqual({ body: { path: "/src/shop", kind: "project" } });
  });

  it("sends only the path to a legacy server or one whose level is unknown", () => {
    expect(gateWorkspaceRequest({ path: "/src/shop", kind: "runner", name: "stack" }, legacy)).toEqual({ body: { path: "/src/shop" } });
    expect(gateWorkspaceRequest({ path: "/src/shop", kind: "runner" }, undefined)).toEqual({ body: { path: "/src/shop" } });
  });

  it("refuses an incompatible server", () => {
    expect("refusal" in gateWorkspaceRequest({ path: "/src/shop" }, incompatible)).toBe(true);
  });
});
