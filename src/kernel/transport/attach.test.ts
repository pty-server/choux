import { PROTOCOL_VERSION } from "@pty-server/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachController,
  SOCKET_OPEN,
  binaryStringToBytes,
  type AttachSocket,
  type SocketFactory,
  type TerminalLike,
} from "./attach";

class MockTerminal implements TerminalLike {
  cols: number;
  rows: number;
  readonly resizeCalls: { cols: number; rows: number }[] = [];
  readonly writes: (string | Uint8Array)[] = [];
  private dataCallback: ((data: string) => void) | undefined;
  private binaryCallback: ((data: string) => void) | undefined;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.writes.push(data);
    callback?.();
  }

  onData(callback: (data: string) => void) {
    this.dataCallback = callback;
    return {
      dispose: () => {
        this.dataCallback = undefined;
      },
    };
  }

  onBinary(callback: (data: string) => void) {
    this.binaryCallback = callback;
    return {
      dispose: () => {
        this.binaryCallback = undefined;
      },
    };
  }

  emitData(data: string): void {
    this.dataCallback?.(data);
  }

  emitBinary(data: string): void {
    this.binaryCallback?.(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeCalls.push({ cols, rows });
  }

  reset(): void {}
}

class MockSocket implements AttachSocket {
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }

  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }
}

function createController(
  options: { readonly?: boolean; clientProtocolVersion?: number; onProtocolMismatch?: (serverProtocol: number) => void } = {},
) {
  const terminal = new MockTerminal(80, 24);
  const sockets: MockSocket[] = [];
  const createSocket: SocketFactory = () => {
    const socket = new MockSocket();
    sockets.push(socket);
    return socket;
  };
  const controller = new AttachController({
    baseUrl: "http://example.test",
    sessionId: "session-1",
    token: "token",
    cols: terminal.cols,
    rows: terminal.rows,
    terminal,
    createSocket,
    clientProtocolVersion: PROTOCOL_VERSION,
    ...options,
  });
  const socket = sockets[0];
  if (!socket) throw new Error("AttachController did not create a socket");

  return { controller, socket, sockets, terminal };
}

function openSocket(socket: MockSocket): void {
  socket.readyState = SOCKET_OPEN;
  socket.onopen?.();
}

describe("AttachController server-authoritative dimensions", () => {
  it("only changes terminal dimensions when the server sends ready or resized", () => {
    const { controller, socket, terminal } = createController();
    openSocket(socket);

    socket.onmessage?.({ data: JSON.stringify({ t: "ready", cols: 100, rows: 30 }) });
    expect(terminal.cols).toBe(100);
    expect(terminal.rows).toBe(30);

    controller.resize(120, 40);
    expect(socket.sent).toHaveLength(1);
    const resizeRequest = socket.sent[0];
    if (typeof resizeRequest !== "string") throw new Error("Expected a JSON resize frame");
    expect(JSON.parse(resizeRequest)).toEqual({ t: "resize", cols: 120, rows: 40 });
    expect(terminal.cols).toBe(100);
    expect(terminal.rows).toBe(30);

    socket.onmessage?.({ data: JSON.stringify({ t: "resized", cols: 110, rows: 35 }) });
    expect(terminal.cols).toBe(110);
    expect(terminal.rows).toBe(35);
  });

  it("does not send resize requests for readonly controllers", () => {
    const { controller, socket } = createController({ readonly: true });
    openSocket(socket);

    controller.resize(120, 40);

    expect(socket.sent).toHaveLength(0);
  });
});

describe("AttachController terminal input", () => {
  it("forwards legacy mouse reports as their original bytes", () => {
    const { socket, terminal } = createController();
    openSocket(socket);
    socket.onmessage?.({ data: JSON.stringify({ t: "ready", cols: 80, rows: 24 }) });

    terminal.emitBinary("\u001b[M\u00e1\u009b\u00ff");

    expect(socket.sent).toHaveLength(1);
    expect(Array.from(socket.sent[0] as Uint8Array)).toEqual([0x1b, 0x5b, 0x4d, 0xe1, 0x9b, 0xff]);
  });

  it("does not forward terminal input from readonly sessions", () => {
    const { socket, terminal } = createController({ readonly: true });
    openSocket(socket);
    socket.onmessage?.({ data: JSON.stringify({ t: "ready", cols: 80, rows: 24 }) });

    terminal.emitData("hello");
    terminal.emitBinary("\u001b[M");

    expect(socket.sent).toEqual([]);
  });
});

describe("binaryStringToBytes", () => {
  it("preserves each binary-string code unit", () => {
    expect(Array.from(binaryStringToBytes("\u0000\u007f\u0080\u00ff"))).toEqual([0, 0x7f, 0x80, 0xff]);
  });
});

describe("AttachController protocol mismatch reporting", () => {
  it("does not report a matching ready protocol", () => {
    const reportedProtocols: number[] = [];
    const { socket } = createController({ onProtocolMismatch: (protocol) => reportedProtocols.push(protocol) });
    openSocket(socket);

    socket.onmessage?.({ data: JSON.stringify({ t: "ready", cols: 80, rows: 24, protocol: PROTOCOL_VERSION }) });

    expect(reportedProtocols).toEqual([]);
  });

  it("does not report a missing ready protocol", () => {
    const reportedProtocols: number[] = [];
    const { socket } = createController({ onProtocolMismatch: (protocol) => reportedProtocols.push(protocol) });
    openSocket(socket);

    socket.onmessage?.({ data: JSON.stringify({ t: "ready", cols: 80, rows: 24 }) });

    expect(reportedProtocols).toEqual([]);
  });

  it("does not report a mismatch when no clientProtocolVersion was configured", () => {
    const reportedProtocols: number[] = [];
    const { socket } = createController({
      clientProtocolVersion: undefined,
      onProtocolMismatch: (protocol) => reportedProtocols.push(protocol),
    });
    openSocket(socket);

    socket.onmessage?.({ data: JSON.stringify({ t: "ready", cols: 80, rows: 24, protocol: PROTOCOL_VERSION + 1 }) });

    expect(reportedProtocols).toEqual([]);
  });

  it("reports a mismatched ready protocol once", () => {
    const reportedProtocols: number[] = [];
    const mismatchedProtocol = PROTOCOL_VERSION + 1;
    const { socket } = createController({ onProtocolMismatch: (protocol) => reportedProtocols.push(protocol) });
    openSocket(socket);

    socket.onmessage?.({ data: JSON.stringify({ t: "ready", cols: 80, rows: 24, protocol: mismatchedProtocol }) });

    expect(reportedProtocols).toEqual([mismatchedProtocol]);
  });
});

describe("AttachController reconnect", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("orphans the previous socket when an error frame triggers a reconnect", () => {
    vi.useFakeTimers();
    const { socket, sockets, terminal } = createController();
    openSocket(socket);
    socket.onmessage?.({ data: JSON.stringify({ t: "ready", cols: 80, rows: 24, protocol: PROTOCOL_VERSION }) });

    socket.onmessage?.({ data: JSON.stringify({ t: "error", reason: "server said no" }) });
    vi.runOnlyPendingTimers();

    expect(sockets).toHaveLength(2);
    expect(socket.closeCalls).toBe(1);
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();

    vi.runOnlyPendingTimers();
    expect(sockets).toHaveLength(2);
    expect(terminal.writes).toEqual([]);
  });
});
