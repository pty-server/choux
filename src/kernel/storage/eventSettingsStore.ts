import { defaultEventSettings, normalizeEventSettings, type EventSettings } from "../../registry/eventSettings";
import { metaStoreName, openDatabase } from "./db";

const eventSettingsKey = "eventSettings";

export async function getEventSettings(): Promise<EventSettings> {
  const db = await openDatabase();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(eventSettingsKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return saved === undefined ? { ...defaultEventSettings } : normalizeEventSettings(saved);
}

export async function saveEventSettings(settings: EventSettings): Promise<void> {
  const db = await openDatabase();
  const normalized = normalizeEventSettings(settings);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(normalized, eventSettingsKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
