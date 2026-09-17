import type { UpdateChannel } from "../../registry/appUpdate";
import { isTauriRuntime, type TauriInvoke } from "../storage/tokenStore";

const UNBUNDLED_BUILD_MESSAGE = "This build was not installed from a release bundle, so it cannot update itself.";

const READ_ONLY_BUNDLE_MESSAGE = "Choux is running from a read-only location, such as its disk image. Move it to Applications, reopen it, and try again.";

export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface PendingAppUpdate {
  readonly version: string;
  install(onProgress: (fraction: number | undefined) => void): Promise<void>;
}

export interface AppUpdateBridge {
  currentVersion(): Promise<string>;
  check(channel: UpdateChannel): Promise<PendingAppUpdate | undefined>;
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
    async check(channel) {
      const { getBundleType } = await import("@tauri-apps/api/app");
      if (!(await getBundleType())) throw new Error(UNBUNDLED_BUILD_MESSAGE);
      const { invoke } = await import("@tauri-apps/api/core");
      const offered = await (invoke as TauriInvoke)<{ version: string } | null>("app_update_check", { channel });
      if (!offered) return undefined;
      return {
        version: offered.version,
        async install(onProgress) {
          const { Channel, invoke: invokeInstall } = await import("@tauri-apps/api/core");
          if (await (invokeInstall as TauriInvoke)<boolean>("app_bundle_read_only")) throw new Error(READ_ONLY_BUNDLE_MESSAGE);
          const progress = new Channel<DownloadEvent>();
          progress.onmessage = trackDownloadProgress(onProgress);
          await (invokeInstall as TauriInvoke)<null>("app_update_install", { version: offered.version, onProgress: progress });
        },
      };
    },
    async relaunch() {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}
