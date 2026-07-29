import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@pty-server/protocol";
import { ApiError, createApiClient } from "../transport/api";
import { resetDbMemo } from "../storage/db";
import { createServerRegistry } from "./serverRegistry.svelte";
import { addServer, tokenStore } from "../storage/serverConfigStore";
import { resetIndexedDB } from "../storage/setup";
import type { EventSocket } from "../transport/events";

type Client = ReturnType<typeof createApiClient>;

/** A `Client` whose methods keep their vitest mock surface (`mockResolvedValueOnce` etc). */
type MockClient = Client & {
  [K in "getSessions" | "getWorkspaces" | "getInfo" | "createWorkspace" | "createSession"]: ReturnType<typeof vi.fn>;
};

class MockEventSocket implements EventSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

function clientWith(options: {
  sessions?: unknown[];
  workspaces?: unknown[];
  protocol?: number;
  getInfo?: ReturnType<typeof vi.fn>;
} = {}): MockClient {
  return {
    getSessions: vi.fn().mockResolvedValue(options.sessions ?? []),
    getWorkspaces: vi.fn().mockResolvedValue(options.workspaces ?? []),
    getInfo: options.getInfo ?? vi.fn().mockResolvedValue({ protocol: options.protocol ?? PROTOCOL_VERSION }),
    createWorkspace: vi.fn(),
    createSession: vi.fn(),
  } as unknown as MockClient;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
}

beforeEach(() => {
  // Only fake setInterval/clearInterval - the sole timer APIs the registry's
  // poll loop uses. Faking setTimeout too would also stall fake-indexeddb's
  // internal request scheduling (it uses setTimeout to dispatch success/error
  // events), which never gets its own timers advanced here - that hangs
  // every await on a DB call forever.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  resetState();
});

afterEach(() => {
  vi.useRealTimers();
  resetState();
});

describe("server registry status", () => {
  it("connects an explicitly no-auth server without reading a credential", async () => {
    const client = clientWith();
    const registry = createServerRegistry({ createClient: () => client, pollIntervalMs: 1000 });

    const conn = await registry.addServer({ url: "http://127.0.0.1:7801", auth: "none" });
    await settle();

    expect(registry.get(conn.config.id)?.status).toBe("online");
    expect(client.getInfo).toHaveBeenCalledTimes(1);
  });

  it("derives online and version-mismatch status from the protocol", async () => {
    const matching = clientWith();
    const mismatched = clientWith({ protocol: PROTOCOL_VERSION + 1 });
    const createClient = vi.fn()
      .mockReturnValueOnce(matching)
      .mockReturnValueOnce(mismatched);
    const registry = createServerRegistry({ createClient, pollIntervalMs: 1000 });

    const first = await registry.addServer({ url: "http://one.test", token: "one" });
    const second = await registry.addServer({ url: "http://two.test", token: "two" });
    await settle();

    expect(registry.get(first.config.id)?.status).toBe("online");
    expect(registry.get(second.config.id)?.status).toBe("version-mismatch");
  });

  it("derives unauthorized and offline status from poll failures", async () => {
    const unauthorized = clientWith({ getInfo: vi.fn().mockRejectedValue(new ApiError("nope", 401)) });
    const offline = clientWith({ getInfo: vi.fn().mockRejectedValue(new Error("network")) });
    const createClient = vi.fn()
      .mockReturnValueOnce(unauthorized)
      .mockReturnValueOnce(offline);
    const registry = createServerRegistry({ createClient, pollIntervalMs: 1000 });

    const first = await registry.addServer({ url: "http://one.test", token: "one" });
    const second = await registry.addServer({ url: "http://two.test", token: "two" });
    await settle();

    expect(registry.get(first.config.id)?.status).toBe("unauthorized");
    expect(registry.get(second.config.id)?.status).toBe("offline");
    expect(registry.get(first.config.id)?.connectionError).toBe("Authentication failed (401 Unauthorized). Check the server token.");
    expect(registry.get(second.config.id)?.connectionError).toBe("network");
  });
});

describe("server registry polling", () => {
  it("refreshes immediately and preserves last-good data after a transient failure", async () => {
    const client = clientWith({ sessions: [{ id: "old" }], workspaces: [{ id: "old-workspace" }] });
    const registry = createServerRegistry({ createClient: () => client, pollIntervalMs: 1000 });
    const conn = await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();

    client.getSessions.mockResolvedValueOnce([{ id: "new" }]);
    client.getWorkspaces.mockResolvedValueOnce([{ id: "new-workspace" }]);
    registry.refresh(conn.config.id);
    await settle();
    expect(registry.get(conn.config.id)?.sessions).toEqual([{ id: "new" }]);
    expect(registry.get(conn.config.id)?.workspaces).toEqual([{ id: "new-workspace" }]);

    client.getInfo.mockRejectedValueOnce(new Error("dropped"));
    registry.refresh(conn.config.id);
    await settle();
    expect(registry.get(conn.config.id)?.status).toBe("offline");
    expect(registry.get(conn.config.id)?.sessions).toEqual([{ id: "new" }]);
    expect(registry.get(conn.config.id)?.workspaces).toEqual([{ id: "new-workspace" }]);
  });

  it("does not overlap polls", async () => {
    let resolveInfo: ((value: { protocol: number }) => void) | undefined;
    const getInfo = vi.fn(() => new Promise<{ protocol: number }>((resolve) => {
      resolveInfo = resolve;
    }));
    const client = clientWith({ getInfo });
    const registry = createServerRegistry({ createClient: () => client, pollIntervalMs: 1000 });
    await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getSessions).toHaveBeenCalledTimes(1);
    expect(client.getWorkspaces).toHaveBeenCalledTimes(1);
    expect(getInfo).toHaveBeenCalledTimes(1);

    resolveInfo?.({ protocol: PROTOCOL_VERSION });
    await settle();
  });
});

describe("server registry event stream", () => {
  it("queues Ptys questions globally and replies with an option or note", async () => {
    const sockets: MockEventSocket[] = [];
    const revealQuestion = vi.fn();
    const client = clientWith({ sessions: [{ id: "session-1", name: "Agent" }, { id: "session-2", name: "Build" }] });
    const registry = createServerRegistry({
      createClient: () => client,
      revealQuestion,
      createEventSocket: () => {
        const socket = new MockEventSocket();
        sockets.push(socket);
        return socket;
      },
      pollIntervalMs: 1000,
    });
    const conn = await registry.addServer({ url: "http://one.test", token: "one", label: "Local" });
    await settle();
    const socket = sockets[0];
    if (!socket) throw new Error("Expected an event socket");
    socket.readyState = 1;

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      requestId: "request-1",
      ttl: 0,
      event: {
        sessionId: "session-1",
        type: "ptys.question",
        data: { message: "Allow changes?", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }] },
      },
    }) });
    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      requestId: "request-2",
      ttl: 0,
      event: {
        sessionId: "session-2",
        type: "ptys.question",
        data: { message: "Run tests?", options: [{ id: "yes", label: "Yes" }] },
      },
    }) });

    expect(registry.pendingQuestions.map((question) => question.message)).toEqual(["Allow changes?", "Run tests?"]);
    expect(registry.pendingQuestions[0]).toMatchObject({ serverId: conn.config.id, serverLabel: "Local", sessionLabel: "Agent" });
    expect(revealQuestion).toHaveBeenCalledTimes(1);
    expect(registry.answerQuestion(`${conn.config.id}:request-1`, { answer: "allow", note: "Only this file" })).toEqual({ ok: true });
    expect(registry.answerQuestion(`${conn.config.id}:request-2`, { cancelled: true })).toEqual({ ok: true });
    expect(registry.pendingQuestions).toEqual([]);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      {
        t: "event.reply",
        requestId: "request-1",
        event: { type: "ptys.question.answer", data: { answer: "allow", note: "Only this file" } },
      },
      {
        t: "event.reply",
        requestId: "request-2",
        event: { type: "ptys.question.answer", data: { cancelled: true } },
      },
    ]);
  });

  it("removes question requests when their session exits", async () => {
    const sockets: MockEventSocket[] = [];
    const registry = createServerRegistry({
      createClient: () => clientWith(),
      createEventSocket: () => {
        const socket = new MockEventSocket();
        sockets.push(socket);
        return socket;
      },
      pollIntervalMs: 1000,
    });
    const conn = await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();
    const socket = sockets[0];
    if (!socket) throw new Error("Expected an event socket");

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      requestId: "request-1",
      ttl: 0,
      event: { sessionId: "session-1", type: "ptys.question", data: { message: "Continue?", options: [{ id: "yes", label: "Yes" }] } },
    }) });
    expect(registry.pendingQuestions).toHaveLength(1);
    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      event: { sessionId: "session-1", type: "session.exited", data: { code: 0, at: 1 } },
    }) });
    expect(registry.pendingQuestions).toEqual([]);
    await registry.removeServer(conn.config.id);
  });

  it("expires finite-TTL questions from the queue", async () => {
    const sockets: MockEventSocket[] = [];
    const registry = createServerRegistry({
      createClient: () => clientWith(),
      createEventSocket: () => {
        const socket = new MockEventSocket();
        sockets.push(socket);
        return socket;
      },
      pollIntervalMs: 1000,
    });
    await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();
    const socket = sockets[0];
    if (!socket) throw new Error("Expected an event socket");

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      requestId: "request-1",
      ttl: 0.01,
      event: { sessionId: "session-1", type: "ptys.question", data: { message: "Continue?", options: [{ id: "yes", label: "Yes" }] } },
    }) });
    expect(registry.pendingQuestions).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(registry.pendingQuestions).toEqual([]);
  });

  it("applies terminal titles and session renames from a server event stream", async () => {
    const sockets: MockEventSocket[] = [];
    const client = clientWith({ sessions: [{ id: "session-1", name: "original" }] });
    const registry = createServerRegistry({
      createClient: () => client,
      createEventSocket: () => {
        const socket = new MockEventSocket();
        sockets.push(socket);
        return socket;
      },
      pollIntervalMs: 1000,
    });
    const conn = await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();
    const socket = sockets[0];
    if (!socket) throw new Error("Expected an event socket");

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      event: { sessionId: "session-1", type: "session.title", data: { title: "build logs" } },
    }) });
    expect(registry.get(conn.config.id)?.terminalTitles).toEqual({ "session-1": "build logs" });

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      event: { sessionId: "session-1", type: "session.updated", data: { name: "renamed" } },
    }) });
    expect(registry.get(conn.config.id)?.sessions[0]?.name).toBe("renamed");

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      event: {
        sessionId: "session-2",
        type: "session.created",
        data: {
          id: "session-2",
          workspaceId: "workspace-1",
          cmd: "sh",
          args: [],
          env: {},
          cols: 80,
          rows: 24,
          createdAt: 10,
        },
      },
    }) });
    expect(registry.get(conn.config.id)?.sessions.map((session) => session.id)).toEqual(["session-1", "session-2"]);

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      event: { sessionId: "session-2", type: "session.exited", data: { code: 0, at: 20 } },
    }) });
    expect(registry.get(conn.config.id)?.sessions[1]?.exited).toEqual({ code: 0, at: 20 });

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      event: { sessionId: "session-1", type: "session.title", data: { title: "" } },
    }) });
    expect(registry.get(conn.config.id)?.terminalTitles).toEqual({});
  });

  it("keeps an event-applied rename when an older poll finishes later", async () => {
    let resolveStaleSessions: ((sessions: unknown[]) => void) | undefined;
    const sockets: MockEventSocket[] = [];
    const client = clientWith({ sessions: [{ id: "session-1", name: "original" }] });
    const getSessions = client.getSessions as unknown as ReturnType<typeof vi.fn>;
    getSessions.mockImplementationOnce(() => Promise.resolve([{ id: "session-1", name: "original" }]))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStaleSessions = resolve; }));
    const registry = createServerRegistry({
      createClient: () => client,
      createEventSocket: () => {
        const socket = new MockEventSocket();
        sockets.push(socket);
        return socket;
      },
      pollIntervalMs: 1000,
    });
    const conn = await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();
    registry.refresh(conn.config.id);
    await settle();

    sockets[0]?.onmessage?.({ data: JSON.stringify({
      t: "event",
      event: { sessionId: "session-1", type: "session.updated", data: { name: "renamed" } },
    }) });
    resolveStaleSessions?.([{ id: "session-1", name: "original" }]);
    await settle();

    expect(registry.get(conn.config.id)?.sessions[0]?.name).toBe("renamed");
  });
});

describe("server registry lifecycle", () => {
  it("hydrates one controller per stored server", async () => {
    await addServer({ url: "http://one.test", token: "one" });
    await addServer({ url: "http://two.test", token: "two" });
    const createClient = vi.fn(() => clientWith());
    const registry = createServerRegistry({ createClient, pollIntervalMs: 1000 });

    await registry.load();
    await settle();

    expect(registry.servers).toHaveLength(2);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("adds and removes controllers and deletes removed tokens", async () => {
    const client = clientWith();
    const registry = createServerRegistry({ createClient: () => client, pollIntervalMs: 1000 });
    const conn = await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();
    expect(registry.servers).toHaveLength(1);
    expect(client.getInfo).toHaveBeenCalledTimes(1);

    await registry.removeServer(conn.config.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(registry.servers).toHaveLength(0);
    expect(await tokenStore.get(conn.config.tokenRef)).toBeUndefined();
    expect(client.getInfo).toHaveBeenCalledTimes(1);
  });

  it("closes the event stream when a server is removed", async () => {
    const sockets: MockEventSocket[] = [];
    const registry = createServerRegistry({
      createClient: () => clientWith(),
      createEventSocket: () => {
        const socket = new MockEventSocket();
        sockets.push(socket);
        return socket;
      },
      pollIntervalMs: 1000,
    });
    const conn = await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();

    await registry.removeServer(conn.config.id);
    expect(sockets[0]?.closed).toBe(true);
  });

  it("updates label/accent in place without reconnecting", async () => {
    const client = clientWith();
    const createClient = vi.fn(() => client);
    const registry = createServerRegistry({ createClient, pollIntervalMs: 1000 });
    const conn = await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();
    expect(createClient).toHaveBeenCalledTimes(1);

    await registry.updateServer(conn.config.id, { label: "Renamed", accent: "#123456" });
    await settle();

    expect(registry.get(conn.config.id)?.config.label).toBe("Renamed");
    expect(registry.get(conn.config.id)?.config.accent).toBe("#123456");
    // No url/token change -> no reconnect, same client instance reused.
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("reconnects when the url changes and preserves the token", async () => {
    const client = clientWith();
    const createClient = vi.fn(() => client);
    const registry = createServerRegistry({ createClient, pollIntervalMs: 1000 });
    const conn = await registry.addServer({ url: "http://one.test", token: "one" });
    await settle();
    expect(createClient).toHaveBeenCalledTimes(1);
    const tokenRef = conn.config.tokenRef;

    await registry.updateServer(conn.config.id, { url: "http://one-new.test" });
    await settle();

    expect(registry.get(conn.config.id)?.config.url).toBe("http://one-new.test");
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(await tokenStore.get(tokenRef)).toBe("one");
  });

  it("reconnects and overwrites the token when a new token is provided, keeping unspecified fields", async () => {
    const client = clientWith();
    const createClient = vi.fn(() => client);
    const registry = createServerRegistry({ createClient, pollIntervalMs: 1000 });
    const conn = await registry.addServer({ url: "http://one.test", token: "one", label: "Original" });
    await settle();
    const tokenRef = conn.config.tokenRef;

    await registry.updateServer(conn.config.id, { token: "brand-new-token" });
    await settle();

    expect(await tokenStore.get(tokenRef)).toBe("brand-new-token");
    expect(registry.get(conn.config.id)?.config.label).toBe("Original");
    expect(registry.get(conn.config.id)?.config.url).toBe("http://one.test");
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("is a no-op for an unknown server id", async () => {
    const registry = createServerRegistry({ createClient: () => clientWith(), pollIntervalMs: 1000 });
    await expect(registry.updateServer("does-not-exist", { label: "x" })).resolves.toBeUndefined();
  });

  it("selects and persists the default server", async () => {
    const registry = createServerRegistry({ createClient: () => clientWith(), pollIntervalMs: 1000 });
    const first = await registry.addServer({ url: "http://one.test", token: "one" });
    const second = await registry.addServer({ url: "http://two.test", token: "two" });
    expect(registry.defaultServerId).toBe(first.config.id);
    await registry.setDefault(second.config.id);

    expect(registry.defaultServerId).toBe(second.config.id);

    const fresh = createServerRegistry({ createClient: () => clientWith(), pollIntervalMs: 1000 });
    await fresh.load();
    expect(fresh.defaultServerId).toBe(second.config.id);
  });
});
