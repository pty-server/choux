import type { AppUpdateState, AppUpdateStatus } from "../../registry/appUpdate";
import { getAppUpdateBridge, type AppUpdateBridge, type PendingAppUpdate } from "./appUpdate";

export const APP_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface AppUpdateWatch extends AppUpdateState {
  start(): () => void;
  checkNow(): Promise<void>;
  install(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAppUpdateWatch(bridge: AppUpdateBridge | undefined): AppUpdateWatch {
  let currentVersion = $state<string>();
  let status = $state<AppUpdateStatus>({ phase: "idle" });
  let pending: PendingAppUpdate | undefined;

  function isBusy(): boolean {
    return status.phase === "checking" || status.phase === "installing";
  }

  function offer(update: PendingAppUpdate): void {
    pending = update;
    status = { phase: "available", version: update.version };
  }

  async function checkInBackground(): Promise<void> {
    if (!bridge || isBusy()) return;
    try {
      const update = await bridge.check();
      if (update && !isBusy()) offer(update);
    } catch {
      return;
    }
  }

  async function checkNow(): Promise<void> {
    if (!bridge || isBusy()) return;
    status = { phase: "checking" };
    try {
      const update = await bridge.check();
      if (update) offer(update);
      else status = { phase: "current" };
    } catch (error) {
      status = { phase: "failed", version: pending?.version, message: errorMessage(error) };
    }
  }

  async function install(): Promise<void> {
    const update = pending;
    if (!bridge || !update || isBusy()) return;
    status = { phase: "installing", version: update.version, progress: undefined };
    try {
      await update.install((progress) => {
        status = { phase: "installing", version: update.version, progress };
      });
      await bridge.relaunch();
    } catch (error) {
      status = { phase: "failed", version: update.version, message: errorMessage(error) };
    }
  }

  return {
    get supported() {
      return bridge !== undefined;
    },
    get currentVersion() {
      return currentVersion;
    },
    get status() {
      return status;
    },
    start() {
      if (!bridge) return () => {};
      void bridge.currentVersion().then((version) => {
        currentVersion = version;
      }).catch(() => {});
      void checkInBackground();
      const interval = setInterval(() => void checkInBackground(), APP_UPDATE_CHECK_INTERVAL_MS);
      return () => clearInterval(interval);
    },
    checkNow,
    install,
  };
}

export const appUpdateWatch = createAppUpdateWatch(getAppUpdateBridge());
