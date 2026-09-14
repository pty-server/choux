import { PROTOCOL_MINOR, PROTOCOL_VERSION, type Workspace } from "@pty-server/protocol";
import { describe, expect, it, vi } from "vitest";
import { openHomeProject } from "./localAutostart";

const homeProject: Workspace = { id: "w1", kind: "project", name: "user", path: "/home/user", realpath: "/home/user", createdAt: 1 };

function steps(protocol: { protocol: number; protocolMinor?: number }) {
  const calls: string[] = [];
  const record = <T>(name: string, value: T) => vi.fn(async () => { calls.push(name); return value; });
  return {
    calls,
    getInfo: record("getInfo", { version: "0.2.0", serverId: "s", uptime: 0, sessions: 0, user: "user", workspaces: 0, ...protocol }),
    home: record<string | undefined>("home", "/home/user"),
    createWorkspace: record("createWorkspace", homeProject),
    startSession: vi.fn<(workspaceId: string | undefined) => void>(() => { calls.push("startSession"); }),
  };
}

describe("openHomeProject", () => {
  it("creates a home project and starts the session in it", async () => {
    const run = steps({ protocol: PROTOCOL_VERSION, protocolMinor: PROTOCOL_MINOR });

    await openHomeProject(run);

    expect(run.calls).toEqual(["getInfo", "home", "createWorkspace", "startSession"]);
    expect(run.createWorkspace).toHaveBeenCalledWith({ path: "/home/user", kind: "project" });
    expect(run.startSession).toHaveBeenCalledWith("w1");
  });

  it("starts the session in the default workspace of a legacy server without creating one", async () => {
    const run = steps({ protocol: PROTOCOL_VERSION });

    await openHomeProject(run);

    expect(run.calls).toEqual(["getInfo", "startSession"]);
    expect(run.startSession).toHaveBeenCalledWith(undefined);
  });

  it("sends nothing after the info request to an incompatible server", async () => {
    const run = steps({ protocol: PROTOCOL_VERSION + 1 });

    await expect(openHomeProject(run)).rejects.toThrow(`${PROTOCOL_VERSION + 1}.0`);
    expect(run.calls).toEqual(["getInfo"]);
  });

  it("starts no session when the home directory is unknown", async () => {
    const run = steps({ protocol: PROTOCOL_VERSION, protocolMinor: PROTOCOL_MINOR });
    run.home.mockResolvedValue(undefined);

    await expect(openHomeProject(run)).rejects.toThrow("home directory");
    expect(run.createWorkspace).not.toHaveBeenCalled();
    expect(run.startSession).not.toHaveBeenCalled();
  });

  it("starts no session when the workspace request fails", async () => {
    const run = steps({ protocol: PROTOCOL_VERSION, protocolMinor: PROTOCOL_MINOR });
    run.createWorkspace.mockRejectedValue(new Error("path does not exist"));

    await expect(openHomeProject(run)).rejects.toThrow("path does not exist");
    expect(run.startSession).not.toHaveBeenCalled();
  });
});
