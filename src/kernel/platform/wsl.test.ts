import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWslBridge } from "./wsl";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("getWslBridge", () => {
  beforeEach(() => {
    Object.assign(globalThis, { window: { __TAURI_INTERNALS__: {} } });
    invoke.mockReset();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("is unavailable outside the desktop app", async () => {
    delete (globalThis as { window?: unknown }).window;

    await expect(getWslBridge()).resolves.toBeUndefined();
  });

  it("reads missing native values as absent keys", async () => {
    invoke.mockResolvedValueOnce({ supported: true, version: "2.7.14.0", problem: null, distros: [{ name: "Debian", default: true, running: false, version: null }] });
    invoke.mockResolvedValueOnce({ user: "me", home: "/home/me", nodeAvailable: true, nodeBin: null, npmAvailable: true, ptysVersion: null, message: null });
    const bridge = await getWslBridge();

    await expect(bridge?.status()).resolves.toStrictEqual({ supported: true, version: "2.7.14.0", distros: [{ name: "Debian", default: true, running: false }] });
    await expect(bridge?.probe("Debian")).resolves.toStrictEqual({ user: "me", home: "/home/me", nodeAvailable: true, npmAvailable: true });
    expect(invoke).toHaveBeenLastCalledWith("wsl_probe", { distro: "Debian", user: undefined, onlyRunning: undefined });
  });

  it("sends a host without an absent node directory", async () => {
    invoke.mockResolvedValue(undefined);
    const bridge = await getWslBridge();

    await bridge?.start({ distro: "Debian", user: "me" }, "default");

    expect(invoke).toHaveBeenCalledWith("wsl_start", { host: { distro: "Debian", user: "me" }, instance: "default" });
  });
});
