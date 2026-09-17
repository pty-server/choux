import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateBridge, PendingAppUpdate } from "./appUpdate";
import { APP_UPDATE_CHECK_INTERVAL_MS, createAppUpdateWatch } from "./appUpdateWatch.svelte";

function pendingUpdate(version: string, install: PendingAppUpdate["install"] = async () => {}): PendingAppUpdate {
  return { version, install };
}

function fakeBridge(overrides: Partial<AppUpdateBridge> = {}): AppUpdateBridge {
  return {
    currentVersion: async () => "0.2.2",
    check: async () => undefined,
    relaunch: async () => {},
    ...overrides,
  };
}

describe("createAppUpdateWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is unsupported and inert outside the desktop app", async () => {
    const watch = createAppUpdateWatch(undefined);

    watch.start();
    await watch.checkNow();
    await watch.install();

    expect(watch.supported).toBe(false);
    expect(watch.status).toEqual({ phase: "idle" });
  });

  it("checks on start and again after every interval until stopped", async () => {
    const check = vi.fn<AppUpdateBridge["check"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(pendingUpdate("0.3.0"));
    const watch = createAppUpdateWatch(fakeBridge({ check }));

    const stop = watch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watch.currentVersion).toBe("0.2.2");
    expect(watch.status).toEqual({ phase: "idle" });

    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
    expect(watch.status).toEqual({ phase: "available", version: "0.3.0" });

    stop();
    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("keeps background check failures silent", async () => {
    const watch = createAppUpdateWatch(fakeBridge({ check: async () => { throw new Error("offline"); } }));

    const stop = watch.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(watch.status).toEqual({ phase: "idle" });
    stop();
  });

  it("reports a manual check as up to date, available, or failed", async () => {
    const check = vi.fn<AppUpdateBridge["check"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(pendingUpdate("0.3.0"))
      .mockRejectedValueOnce(new Error("offline"));
    const watch = createAppUpdateWatch(fakeBridge({ check }));

    await watch.checkNow();
    expect(watch.status).toEqual({ phase: "current" });

    await watch.checkNow();
    expect(watch.status).toEqual({ phase: "available", version: "0.3.0" });

    await watch.checkNow();
    expect(watch.status).toEqual({ phase: "failed", version: "0.3.0", message: "offline" });
  });

  it("installs with progress and then relaunches", async () => {
    const relaunch = vi.fn(async () => {});
    const seen: unknown[] = [];
    const watch = createAppUpdateWatch(fakeBridge({
      relaunch,
      check: async () => pendingUpdate("0.3.0", async (onProgress) => {
        onProgress(0.5);
        seen.push(watch.status);
      }),
    }));

    await watch.checkNow();
    await watch.install();

    expect(seen).toEqual([{ phase: "installing", version: "0.3.0", progress: 0.5 }]);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("keeps the update installable after a failed install", async () => {
    const install = vi.fn<PendingAppUpdate["install"]>()
      .mockRejectedValueOnce(new Error("authentication cancelled"))
      .mockResolvedValueOnce(undefined);
    const relaunch = vi.fn(async () => {});
    const watch = createAppUpdateWatch(fakeBridge({ relaunch, check: async () => pendingUpdate("0.3.0", install) }));

    await watch.checkNow();
    await watch.install();
    expect(watch.status).toEqual({ phase: "failed", version: "0.3.0", message: "authentication cancelled" });
    expect(relaunch).not.toHaveBeenCalled();

    await watch.install();
    expect(install).toHaveBeenCalledTimes(2);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("does not let a background check interrupt an install", async () => {
    let finishInstall = () => {};
    const check = vi.fn<AppUpdateBridge["check"]>().mockResolvedValue(
      pendingUpdate("0.3.0", () => new Promise<void>((resolve) => { finishInstall = resolve; })),
    );
    const watch = createAppUpdateWatch(fakeBridge({ check }));

    await watch.checkNow();
    const installing = watch.install();
    const stop = watch.start();
    await vi.advanceTimersByTimeAsync(APP_UPDATE_CHECK_INTERVAL_MS);

    expect(check).toHaveBeenCalledOnce();
    expect(watch.status).toEqual({ phase: "installing", version: "0.3.0", progress: undefined });

    finishInstall();
    await installing;
    stop();
  });

  it("re-checks on the new channel and forgets what the old one offered", async () => {
    const check = vi.fn<AppUpdateBridge["check"]>()
      .mockResolvedValueOnce(pendingUpdate("0.3.0"))
      .mockResolvedValueOnce(undefined);
    const watch = createAppUpdateWatch(fakeBridge({ check }));

    await watch.checkNow();
    expect(watch.status).toEqual({ phase: "available", version: "0.3.0" });

    watch.setChannel("rc");
    await vi.advanceTimersByTimeAsync(0);

    expect(watch.channel).toBe("rc");
    expect(check).toHaveBeenLastCalledWith("rc");
    expect(watch.status).toEqual({ phase: "current" });
  });

  it("drops a check that only answers after the channel changed", async () => {
    let answerFirst: (update: PendingAppUpdate | undefined) => void = () => {};
    const check = vi.fn<AppUpdateBridge["check"]>()
      .mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockResolvedValue(undefined);
    const watch = createAppUpdateWatch(fakeBridge({ check }));

    const outstanding = watch.checkNow();
    watch.setChannel("rc");
    answerFirst(pendingUpdate("0.4.0-rc.1"));
    await outstanding;
    await vi.advanceTimersByTimeAsync(0);

    expect(watch.channel).toBe("rc");
    expect(watch.status).toEqual({ phase: "current" });
  });

  it("ignores a switch to the channel already in use", async () => {
    const check = vi.fn<AppUpdateBridge["check"]>().mockResolvedValue(undefined);
    const watch = createAppUpdateWatch(fakeBridge({ check }));

    watch.setChannel("stable");
    await vi.advanceTimersByTimeAsync(0);

    expect(watch.channel).toBe("stable");
    expect(check).not.toHaveBeenCalled();
  });

  it("restores a saved channel without checking, because start checks anyway", async () => {
    const check = vi.fn<AppUpdateBridge["check"]>().mockResolvedValue(undefined);
    const watch = createAppUpdateWatch(fakeBridge({ check }));

    watch.restoreChannel("rc");
    await vi.advanceTimersByTimeAsync(0);
    expect(check).not.toHaveBeenCalled();

    const stop = watch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledWith("rc");
    stop();
  });
});
