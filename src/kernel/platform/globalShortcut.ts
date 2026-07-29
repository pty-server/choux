import { isTauriRuntime, type TauriInvoke } from "../storage/tokenStore";
import { isValidAccelerator } from "../../registry/accelerator";
import type { GlobalShortcutSettings } from "../../registry/globalShortcut";

export function globalShortcutSupported(): boolean {
  return isTauriRuntime();
}

/** Resolves to a failure message when the native side rejects the combination. */
export async function applyGlobalShortcut(settings: GlobalShortcutSettings): Promise<string | undefined> {
  if (!isTauriRuntime()) return undefined;
  if (settings.enabled && !isValidAccelerator(settings.accelerator)) {
    return `${settings.accelerator} is not a usable shortcut.`;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await (invoke as TauriInvoke)<void>("global_shortcut_set", {
      accelerator: settings.enabled ? settings.accelerator : null,
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}