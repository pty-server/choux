import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocalServerBridge, localServerEndpoint } from "./localServer";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("localServerEndpoint", () => {
  it("keeps an instance in a URL-shaped placeholder for native transport", () => {
    expect(localServerEndpoint("work.dev")).toBe("http://work.dev.ptys.local");
  });
});

describe("getLocalServerBridge home", () => {
  beforeEach(() => {
    Object.assign(globalThis, { window: { __TAURI_INTERNALS__: {} } });
    invoke.mockReset();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("reads the home directory through the native command", async () => {
    invoke.mockResolvedValue("/home/user");
    const bridge = await getLocalServerBridge();

    await expect(bridge?.home()).resolves.toBe("/home/user");
    expect(invoke).toHaveBeenCalledWith("local_server_home");
  });

  it("reports a missing home directory as undefined", async () => {
    invoke.mockResolvedValue(null);
    const bridge = await getLocalServerBridge();

    await expect(bridge?.home()).resolves.toBeUndefined();
  });
});
