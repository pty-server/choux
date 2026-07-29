import { metaStoreName, openDatabase } from "./db";
import { isValidAccelerator } from "../../registry/accelerator";
import { defaultGlobalShortcutSettings, type GlobalShortcutSettings } from "../../registry/globalShortcut";

export type { GlobalShortcutSettings } from "../../registry/globalShortcut";

const globalShortcutKey = "globalShortcut";

function normalize(value: unknown): GlobalShortcutSettings {
  if (!value || typeof value !== "object") return { ...defaultGlobalShortcutSettings };
  const saved = value as Record<string, unknown>;
  const accelerator = typeof saved.accelerator === "string" && isValidAccelerator(saved.accelerator)
    ? saved.accelerator
    : defaultGlobalShortcutSettings.accelerator;
  return { enabled: saved.enabled === true, accelerator };
}

export async function getGlobalShortcutSettings(): Promise<GlobalShortcutSettings> {
  const db = await openDatabase();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(globalShortcutKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return normalize(saved);
}

export async function saveGlobalShortcutSettings(settings: GlobalShortcutSettings): Promise<void> {
  const db = await openDatabase();
  const normalized = normalize(settings);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(normalized, globalShortcutKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}