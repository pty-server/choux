import { metaStoreName, openDatabase } from "./db";
import { isValidAccelerator } from "../../registry/accelerator";
import { bindableCommands, type KeybindingOverrides } from "../../registry/keybindings";

export type { KeybindingOverrides } from "../../registry/keybindings";

const keybindingsKey = "keybindings";

function normalize(value: unknown): KeybindingOverrides {
  if (!value || typeof value !== "object") return {};
  const saved = value as Record<string, unknown>;
  const overrides: Record<string, string | null> = {};
  for (const { commandId } of bindableCommands) {
    const override = saved[commandId];
    if (override === null) overrides[commandId] = null;
    else if (typeof override === "string" && isValidAccelerator(override)) overrides[commandId] = override;
  }
  return overrides;
}

export async function getKeybindingOverrides(): Promise<KeybindingOverrides> {
  const db = await openDatabase();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(keybindingsKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return normalize(saved);
}

export async function saveKeybindingOverrides(overrides: KeybindingOverrides): Promise<void> {
  const db = await openDatabase();
  const normalized = normalize(overrides);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(normalized, keybindingsKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}