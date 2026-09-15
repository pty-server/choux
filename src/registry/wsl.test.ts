import { describe, expect, it } from "vitest";
import { defaultWslDistro, distroLabel, wslHost, wslTransport, type WslDistro } from "./wsl";

function distro(name: string, overrides: Partial<WslDistro> = {}): WslDistro {
  return { name, default: false, running: true, version: 2, ...overrides };
}

describe("defaultWslDistro", () => {
  it("prefers the WSL default, unless it runs on WSL 1", () => {
    expect(defaultWslDistro([distro("Ubuntu"), distro("Debian", { default: true })])?.name).toBe("Debian");
    expect(defaultWslDistro([distro("Legacy", { default: true, version: 1 }), distro("Ubuntu")])?.name).toBe("Ubuntu");
    expect(defaultWslDistro([distro("Legacy", { version: 1 })])).toBeUndefined();
  });
});

describe("distroLabel", () => {
  it("notes the default, a stopped distribution and WSL 1", () => {
    expect(distroLabel(distro("Ubuntu"))).toBe("Ubuntu");
    expect(distroLabel(distro("Debian", { default: true, running: false }))).toBe("Debian (default, stopped)");
    expect(distroLabel(distro("Legacy", { running: false, version: 1 }))).toBe("Legacy (WSL 1, not supported)");
  });
});

describe("wslTransport", () => {
  it("carries the node directory only when one was found", () => {
    expect(wslTransport(wslHost("Debian", { user: "me" }), "default")).toEqual({ kind: "wsl", distro: "Debian", user: "me", instance: "default" });
    expect(wslTransport(wslHost("Debian", { user: "me", nodeBin: "/opt/node/bin" }), "work"))
      .toEqual({ kind: "wsl", distro: "Debian", user: "me", instance: "work", nodeBin: "/opt/node/bin" });
  });
});
