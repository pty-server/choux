import { metaStoreName, openDatabase } from "./db";

const sidebarWidthKey = "sidebarWidth";

export const defaultSidebarWidth = 260;
export const minSidebarWidth = 180;
export const maxSidebarWidth = 560;

export function clampSidebarWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultSidebarWidth;
  return Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(value)));
}

export async function getSidebarWidth(): Promise<number> {
  const db = await openDatabase();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(sidebarWidthKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return saved === undefined ? defaultSidebarWidth : clampSidebarWidth(saved);
}

export async function saveSidebarWidth(width: number): Promise<void> {
  const db = await openDatabase();
  const clamped = clampSidebarWidth(width);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(clamped, sidebarWidthKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
