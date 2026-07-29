import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIndexedDB } from "./setup";
import { metaStoreName, openDatabase, resetDbMemo } from "./db";
import { getLastOpenSession, saveLastOpenSession } from "./lastSessionStore";

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

beforeEach(resetState);
afterEach(resetState);

describe("last open session", () => {
  it("is absent until a session is saved", async () => {
    expect(await getLastOpenSession()).toBeUndefined();
  });

  it("persists the session and its selected workspace", async () => {
    const session = { serverId: "server-1", sessionId: "session-1", workspaceId: "workspace-1" };
    await saveLastOpenSession(session);
    resetDbMemo();

    expect(await getLastOpenSession()).toEqual(session);
  });

  it("ignores malformed saved values", async () => {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put({ serverId: "server-1" }, "lastOpenSession");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    expect(await getLastOpenSession()).toBeUndefined();
  });
});
