import { describe, expect, it, vi } from "vitest";
import type { WslDistro, WslHost, WslProbe, WslStatus, WslTransport } from "../../registry/wsl";
import { discoverWslServers } from "./wslDiscovery";

function distro(name: string, overrides: Partial<WslDistro> = {}): WslDistro {
  return { name, default: false, running: true, version: 2, ...overrides };
}

function status(...distros: WslDistro[]): WslStatus {
  return { supported: true, version: "2.7.14.0", distros };
}

const withPtys: WslProbe = { user: "me", nodeAvailable: true, nodeBin: "/home/me/.nvm/versions/node/v24.21.0/bin", npmAvailable: true, ptysVersion: "0.3.0" };

describe("discoverWslServers", () => {
  it("adds every live instance of a running distribution as a WSL server", async () => {
    const probe = vi.fn(async () => withPtys);
    const candidates = vi.fn<(host: WslHost) => Promise<string[]>>(async () => ["default", "work"]);
    const added: WslTransport[] = [];

    const ids = await discoverWslServers(status(distro("Debian")), {
      bridge: { probe, candidates },
      ensureServer: async (transport) => { added.push(transport); return `id-${added.length}`; },
    });

    expect(ids).toEqual(["id-1", "id-2"]);
    expect(probe).toHaveBeenCalledWith("Debian", undefined, true);
    expect(candidates).toHaveBeenCalledWith({ distro: "Debian", user: "me", nodeBin: withPtys.nodeBin });
    expect(added).toEqual([
      { kind: "wsl", distro: "Debian", user: "me", instance: "default", nodeBin: withPtys.nodeBin },
      { kind: "wsl", distro: "Debian", user: "me", instance: "work", nodeBin: withPtys.nodeBin },
    ]);
  });

  it("never touches a stopped or WSL 1 distribution", async () => {
    const probe = vi.fn(async () => withPtys);

    const ids = await discoverWslServers(status(distro("Stopped", { running: false }), distro("Legacy", { version: 1 })), {
      bridge: { probe, candidates: async () => ["default"] },
      ensureServer: async () => "id",
    });

    expect(ids).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("skips a distribution without ptys or one that fails, and keeps looking", async () => {
    const candidates = vi.fn(async () => ["default"]);
    const probe = vi.fn(async (name: string): Promise<WslProbe> => {
      if (name === "Broken") throw new Error("WSL could not start");
      if (name === "Bare") return { user: "me", nodeAvailable: false, npmAvailable: false };
      return { user: "me", nodeAvailable: true, npmAvailable: true, ptysVersion: "0.3.0" };
    });

    const ids = await discoverWslServers(status(distro("Broken"), distro("Bare"), distro("Ubuntu")), {
      bridge: { probe, candidates },
      ensureServer: async (transport) => transport.distro,
    });

    expect(ids).toEqual(["Ubuntu"]);
    expect(candidates).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveBeenCalledWith({ distro: "Ubuntu", user: "me" });
  });
});
