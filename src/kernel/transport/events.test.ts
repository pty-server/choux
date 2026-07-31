import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStreamController } from "./events";
import type { EventSocket } from "./events";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("EventStreamController", () => {
  it("uses the event endpoint and bearer subprotocol, then delivers valid events", () => {
    const sockets: MockEventSocket[] = [];
    const createSocket = vi.fn(() => {
      const socket = new MockEventSocket();
      sockets.push(socket);
      return socket;
    });
    const received: unknown[] = [];
    new EventStreamController({
      baseUrl: "https://example.test/ptys",
      token: "secret",
      createSocket,
      onEvent: (event) => received.push(event),
    });

    expect(createSocket).toHaveBeenCalledWith("wss://example.test/v1/events", ["ptys.bearer.secret"]);
    const socket = sockets[0];
    if (!socket) throw new Error("Expected an event socket");

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      event: { sessionId: "session-1", type: "session.title", data: { title: "vim" } },
    }) });
    socket.onmessage?.({ data: "not json" });
    socket.onmessage?.({ data: JSON.stringify({ t: "event", event: { sessionId: "missing-data", type: "session.title" } }) });
    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      requestId: "missing-ttl",
      event: { sessionId: "session-1", type: "choux.question", data: {} },
    }) });

    expect(received).toEqual([
      { t: "event", event: { sessionId: "session-1", type: "session.title", data: { title: "vim" } } },
    ]);
  });

  it("preserves request metadata and sends a correlated reply", () => {
    const sockets: MockEventSocket[] = [];
    const received: unknown[] = [];
    const controller = new EventStreamController({
      baseUrl: "http://example.test",
      createSocket: () => {
        const socket = new MockEventSocket();
        sockets.push(socket);
        return socket;
      },
      onEvent: (event) => received.push(event),
    });
    const socket = sockets[0];
    if (!socket) throw new Error("Expected an event socket");

    socket.onmessage?.({ data: JSON.stringify({
      t: "event",
      requestId: "request-1",
      ttl: 30,
      event: { sessionId: "session-1", type: "choux.question", data: {} },
    }) });
    socket.readyState = 1;

    expect(received).toEqual([{
      t: "event",
      requestId: "request-1",
      ttl: 30,
      event: { sessionId: "session-1", type: "choux.question", data: {} },
    }]);
    expect(controller.reply("request-1", {
      type: "choux.question.answer",
      data: { answer: "allow" },
    })).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify({
      t: "event.reply",
      requestId: "request-1",
      event: { type: "choux.question.answer", data: { answer: "allow" } },
    })]);
  });

  it("reconnects once after a failure and stops permanently when closed", async () => {
    vi.useFakeTimers();
    const sockets: MockEventSocket[] = [];
    const createSocket = vi.fn(() => {
      const socket = new MockEventSocket();
      sockets.push(socket);
      return socket;
    });
    const controller = new EventStreamController({
      baseUrl: "http://example.test",
      createSocket,
      onEvent: () => {},
      random: () => 0,
    });
    const first = sockets[0];
    if (!first) throw new Error("Expected an event socket");

    first.onerror?.(new Error("dropped"));
    first.onclose?.({ code: 1006, reason: "dropped" });
    await vi.advanceTimersByTimeAsync(250);
    expect(createSocket).toHaveBeenCalledTimes(2);

    controller.close();
    expect(sockets[1]?.closed).toBe(true);
    sockets[1]?.onclose?.({ code: 1000, reason: "closed" });
    await vi.advanceTimersByTimeAsync(8000);
    expect(createSocket).toHaveBeenCalledTimes(2);
  });
});
