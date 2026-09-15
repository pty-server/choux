import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIndexedDB } from "./setup";
import { listServers, addServer, getServer, putServer, deleteServer, tokenStore, accentPalette, updateServer } from "./serverConfigStore";
import { legacySettingsStoreName, legacySettingsKey, serversStoreName, resetDbMemo } from "./db";

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
});

describe("migration", () => {
  it("migrates a v1 legacy settings record into a single server", async () => {
    // Seed a v1 DB with legacy data
    const v1DbReq = (indexedDB as IDBFactory).open("ptys-choux", 1);
    await new Promise<void>((resolve, reject) => {
      v1DbReq.onupgradeneeded = () => {
        const db = v1DbReq.result;
        db.createObjectStore(legacySettingsStoreName);
      };
      v1DbReq.onsuccess = () => resolve();
      v1DbReq.onerror = () => reject(v1DbReq.error);
    });

    const db = v1DbReq.result;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(legacySettingsStoreName, "readwrite");
      tx.objectStore(legacySettingsStoreName).put({ baseUrl: "http://127.0.0.1:8080", token: "tok-abc" }, legacySettingsKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    // Trigger migration by opening to v2 (memo was cleared by beforeEach)
    const servers = await listServers();

    expect(servers).toHaveLength(1);
    expect(servers[0].url).toBe("http://127.0.0.1:8080");
    expect(servers[0].label).toBe("127.0.0.1:8080");
    expect(servers[0].tokenRef).toBeDefined();

    const migratedToken = await tokenStore.get(servers[0].tokenRef);
    expect(migratedToken).toBe("tok-abc");

    // Verify no duplication on a second open (clear memo only, preserve DB)
    resetDbMemo();
    const serversAgain = await listServers();
    expect(serversAgain).toHaveLength(1);
  });

  it("does not migrate when servers store already has data", async () => {
    // Open to v2 to create the stores, then seed with existing data
    const v2DbReq = (indexedDB as IDBFactory).open("ptys-choux", 2);
    await new Promise<void>((resolve, reject) => {
      v2DbReq.onupgradeneeded = () => {
        const db = v2DbReq.result;
        db.createObjectStore(legacySettingsStoreName);
        db.createObjectStore(serversStoreName, { keyPath: "id" });
        db.createObjectStore("tokens");
      };
      v2DbReq.onsuccess = () => resolve();
      v2DbReq.onerror = () => reject(v2DbReq.error);
    });

    const db = v2DbReq.result;
    // Pre-populate servers store so migration is skipped
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(serversStoreName, "readwrite");
      tx.objectStore(serversStoreName).put({ id: "existing-id", label: "Existing", accent: "#000000", url: "http://example.com", tokenRef: "ref" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    resetDbMemo();
    const servers = await listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe("existing-id");
  });

  it("reads a local record saved before typed transports as a local transport", async () => {
    await putServer({ id: "legacy-local", label: "Local work", accent: "#000000", url: "http://work.ptys.local", tokenRef: "legacy-local", transport: "local", instance: "work" } as never);

    const [server] = await listServers();

    expect(server.transport).toEqual({ kind: "local", instance: "work" });
    expect(server).not.toHaveProperty("instance");
    expect(server.auth).toBe("none");
  });

  it("keeps an unreadable transport so the server can still be shown and fixed", async () => {
    await putServer({ id: "broken", label: "Broken", accent: "#000000", url: "http://x.ptys.local", tokenRef: "broken", transport: { kind: "tcp" } } as never);

    expect((await getServer("broken"))?.transport).toEqual({ kind: "tcp" });
  });
});

describe("CRUD round-trip", () => {
  it("stores a local instance without a token", async () => {
    const server = await addServer({
      url: "http://ignored.test",
      transport: { kind: "local", instance: "work" },
      label: "Local work",
    });

    expect(server.transport).toEqual({ kind: "local", instance: "work" });
    expect(server.url).toBe("http://work.ptys.local");
    expect(server.auth).toBe("none");
    expect(await tokenStore.get(server.tokenRef)).toBeUndefined();
  });

  it("stores an SSH server with a label named after its host", async () => {
    const server = await addServer({ url: "", transport: { kind: "ssh", host: "me@box", instance: "default", nodeBin: "/opt/node/bin" } });

    expect(server.label).toBe("me@box");
    expect((await getServer(server.id))?.transport).toEqual({ kind: "ssh", host: "me@box", instance: "default", nodeBin: "/opt/node/bin" });
  });

  it("refuses an invalid transport before storing anything", async () => {
    await expect(addServer({ url: "", transport: { kind: "ssh", host: "-oProxyCommand=x", instance: "default" } })).rejects.toThrow("SSH host");
    expect(await listServers()).toHaveLength(0);
  });

  it("changes a native transport and its placeholder URL, but never turns a URL server native", async () => {
    const ssh = await addServer({ url: "", transport: { kind: "ssh", host: "box", instance: "default" } });
    const remote = await addServer({ url: "http://one.test", token: "t" });

    const updated = await updateServer(ssh.id, { transport: { kind: "ssh", host: "box", instance: "work" }, url: "http://ignored.test" });

    expect(updated?.transport).toEqual({ kind: "ssh", host: "box", instance: "work" });
    expect(updated?.url).toBe("http://work.ptys.local");
    await expect(updateServer(remote.id, { transport: { kind: "local", instance: "default" } })).rejects.toThrow();
  });

  it("addServer -> listServers -> getServer -> putServer -> deleteServer", async () => {
    const server = await addServer({ url: "http://localhost:3000", label: "Test", token: "my-token" });

    expect(server.id).toBeDefined();
    expect(server.label).toBe("Test");
    expect(server.url).toBe("http://localhost:3000");
    expect(server.accent).toBe(accentPalette[0]);
    expect(server.tokenRef).toBe(server.id);

    const list = await listServers();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(server.id);

    const fetched = await getServer(server.id);
    expect(fetched).toBeDefined();
    expect(fetched!.url).toBe("http://localhost:3000");

    await putServer({ ...fetched!, label: "Updated" });
    const updated = await getServer(server.id);
    expect(updated!.label).toBe("Updated");
    expect(updated!.url).toBe("http://localhost:3000");

    await deleteServer(server.id);
    expect(await listServers()).toHaveLength(0);
    expect(await tokenStore.get(server.tokenRef)).toBeUndefined();
  });

  it("deleteServer is a no-op for non-existent id", async () => {
    await deleteServer("does-not-exist");
    expect(await listServers()).toHaveLength(0);
  });
});

describe("accent cycling", () => {
  it("assigns accents in palette order as servers are added", async () => {
    const s1 = await addServer({ url: "http://a.com", token: "t1" });
    const s2 = await addServer({ url: "http://b.com", token: "t2" });
    const s3 = await addServer({ url: "http://c.com", token: "t3" });

    expect(s1.accent).toBe(accentPalette[0]);
    expect(s2.accent).toBe(accentPalette[1]);
    expect(s3.accent).toBe(accentPalette[2]);
  });
});
