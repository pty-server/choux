import { metaStoreName, openDatabase } from "./db";

const lastSessionKey = "lastOpenSession";

export interface LastOpenSession {
  serverId: string;
  sessionId: string;
  workspaceId?: string;
}

function normalizeLastOpenSession(value: unknown): LastOpenSession | undefined {
  if (!value || typeof value !== "object") return undefined;
  const saved = value as Record<string, unknown>;
  if (typeof saved.serverId !== "string" || !saved.serverId) return undefined;
  if (typeof saved.sessionId !== "string" || !saved.sessionId) return undefined;
  return {
    serverId: saved.serverId,
    sessionId: saved.sessionId,
    ...(typeof saved.workspaceId === "string" && saved.workspaceId ? { workspaceId: saved.workspaceId } : {}),
  };
}

export async function getLastOpenSession(): Promise<LastOpenSession | undefined> {
  const db = await openDatabase();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(lastSessionKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return normalizeLastOpenSession(saved);
}

export async function saveLastOpenSession(session: LastOpenSession): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(session, lastSessionKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
