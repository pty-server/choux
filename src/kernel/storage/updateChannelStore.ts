import { defaultUpdateChannel, normalizeUpdateChannel, type UpdateChannel } from "../../registry/appUpdate";
import { metaStoreName, openDatabase } from "./db";

const updateChannelKey = "updateChannel";

export async function getUpdateChannel(): Promise<UpdateChannel> {
  const db = await openDatabase();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(updateChannelKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return saved === undefined ? defaultUpdateChannel : normalizeUpdateChannel(saved);
}

export async function saveUpdateChannel(channel: UpdateChannel): Promise<void> {
  const db = await openDatabase();
  const normalized = normalizeUpdateChannel(channel);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(normalized, updateChannelKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
