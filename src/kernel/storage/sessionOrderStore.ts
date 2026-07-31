import { metaStoreName, openDatabase } from "./db";
import type { SessionDropPosition } from "../../registry/types";

const sessionOrderKey = "sessionOrder";

export type SessionOrder = Readonly<Record<string, readonly string[]>>;

export function sessionOrderScope(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export function normalizeSessionOrder(value: unknown): SessionOrder {
  if (typeof value !== "object" || value === null) return {};
  const normalized: Record<string, string[]> = {};
  for (const [scope, ids] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
    }
    if (seen.size > 0) normalized[scope] = [...seen];
  }
  return normalized;
}

export function orderSessions<T extends { id: string }>(sessions: T[], order: readonly string[] | undefined): T[] {
  if (order === undefined || order.length === 0) return sessions;
  const ranked = new Map(order.map((id, index) => [id, index]));
  const unranked = sessions.filter((session) => !ranked.has(session.id));
  const remaining = sessions
    .filter((session) => ranked.has(session.id))
    .sort((a, b) => ranked.get(a.id)! - ranked.get(b.id)!);
  return [...unranked, ...remaining];
}

export function reorderSessionIds(
  ids: readonly string[],
  movedId: string,
  targetId: string,
  position: SessionDropPosition,
): string[] {
  if (movedId === targetId || !ids.includes(movedId) || !ids.includes(targetId)) return [...ids];
  const without = ids.filter((id) => id !== movedId);
  const targetIndex = without.indexOf(targetId);
  const insertAt = position === "before" ? targetIndex : targetIndex + 1;
  return [...without.slice(0, insertAt), movedId, ...without.slice(insertAt)];
}

export async function getSessionOrder(): Promise<SessionOrder> {
  const db = await openDatabase();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(sessionOrderKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return normalizeSessionOrder(saved);
}

export async function saveSessionOrder(order: SessionOrder): Promise<void> {
  const db = await openDatabase();
  const normalized = normalizeSessionOrder(order);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(normalized, sessionOrderKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
