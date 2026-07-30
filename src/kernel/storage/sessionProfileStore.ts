import { metaStoreName, openDatabase } from "./db";
import { normalizeSessionProfiles, type SessionProfiles } from "../../registry/sessionProfiles";

export type { SessionProfile, SessionProfiles } from "../../registry/sessionProfiles";

const sessionProfilesKey = "sessionProfiles";

export async function getSessionProfiles(): Promise<SessionProfiles> {
  const db = await openDatabase();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(sessionProfilesKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return normalizeSessionProfiles(saved);
}

export async function saveSessionProfiles(profiles: SessionProfiles): Promise<void> {
  const db = await openDatabase();
  const normalized = normalizeSessionProfiles(profiles);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(normalized, sessionProfilesKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
