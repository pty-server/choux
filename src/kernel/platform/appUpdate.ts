import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { isTauriRuntime, type TauriInvoke } from "../storage/tokenStore";

const UNBUNDLED_BUILD_MESSAGE = "This build was not installed from a release bundle, so it cannot update itself.";

const READ_ONLY_BUNDLE_MESSAGE = "Choux is running from a read-only location, such as its disk image. Move it to Applications, reopen it, and try again.";

export interface PendingAppUpdate {
  readonly version: string;
  install(onProgress: (fraction: number | undefined) => void): Promise<void>;
}

export interface AppUpdateBridge {
  currentVersion(): Promise<string>;
  check(): Promise<PendingAppUpdate | undefined>;
  relaunch(): Promise<void>;
}

export function trackDownloadProgress(onProgress: (fraction: number | undefined) => void): (event: DownloadEvent) => void {
  let total: number | undefined;
  let received = 0;
  return (event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength || undefined;
        received = 0;
        onProgress(total === undefined ? undefined : 0);
        return;
      case "Progress":
        received += event.data.chunkLength;
        onProgress(total === undefined ? undefined : Math.min(received / total, 1));
        return;
      case "Finished":
        onProgress(1);
    }
  };
}

export function getAppUpdateBridge(): AppUpdateBridge | undefined {
  if (!isTauriRuntime()) return undefined;
  return {
    async currentVersion() {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    async check() {
      const { getBundleType } = await import("@tauri-apps/api/app");
      if (!(await getBundleType())) throw new Error(UNBUNDLED_BUILD_MESSAGE);
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return undefined;
      return {
        version: update.version,
        async install(onProgress) {
          const { invoke } = await import("@tauri-apps/api/core");
          if (await (invoke as TauriInvoke)<boolean>("app_bundle_read_only")) throw new Error(READ_ONLY_BUNDLE_MESSAGE);
          await update.downloadAndInstall(trackDownloadProgress(onProgress));
        },
      };
    },
    async relaunch() {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}
