// The attach hot path (CLIENT.md section 2, 6, 7): binary pty frames arrive
// fast and this module must never cross an abstraction boundary to render
// them. It is deliberately DOM-free - no `@xterm/xterm` (browser) import, no
// `@xterm/addon-fit`, no direct global `WebSocket` construction - so it can
// be driven from Node in tests against `@xterm/headless` and a real `ws`
// socket, exactly as it runs in the browser against real xterm.js. DOM glue
// (measuring the pane, mounting xterm, wiring `FitAddon`) lives in a
// separate file that imports this one, never the other way round.

// Both `@xterm/xterm` (browser) and `@xterm/headless` (Node) `Terminal`
// classes satisfy this shape already - no adapter needed.
export interface AttachDisposable {
  dispose(): void;
}

export interface TerminalLike {
  readonly cols: number;
  readonly rows: number;
  write(data: string | Uint8Array, callback?: () => void): void;
  onData(callback: (data: string) => void): AttachDisposable;
  /**
   * Legacy mouse reports can contain bytes outside UTF-8. xterm.js surfaces
   * those separately so the client can preserve their byte values on the way
   * to the PTY.
   */
  onBinary(callback: (data: string) => void): AttachDisposable;
  resize(cols: number, rows: number): void;
  reset(): void;
}

// A structural subset of the browser `WebSocket` API. The real `WebSocket`
// (browser) and `ws`'s `WebSocket` (Node, used by the test) both satisfy
// this when `binaryType` is set to `"arraybuffer"` - both then deliver
// binary frames as `ArrayBuffer` and text frames as `string` via
// `event.data`, so the controller never needs to know which runtime it's in.
// WebSocket.readyState OPEN value; identical in the browser and Node `ws`.
export const SOCKET_OPEN = 1;

export interface AttachSocket {
  readonly readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string, protocols: string[]) => AttachSocket;

export type AttachState = "connecting" | "attached" | "exited" | "closed";

export type AttachStatus = "online" | "reconnecting" | "offline";

export const BASE_MS = 500;
export const CAP_MS = 8000;

/** Converts xterm.js' binary-string event payload to the original bytes. */
export function binaryStringToBytes(data: string): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index++) {
    bytes[index] = data.charCodeAt(index);
  }
  return bytes;
}

export function computeReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(CAP_MS, BASE_MS * 2 ** attempt);
  return raw / 2 + random() * (raw / 2);
}

export interface AttachDims {
  cols: number;
  rows: number;
}

export interface AttachExitInfo {
  code: number;
  signal?: number;
}

export interface AttachOptions {
  /** HTTP(S) base URL of the ptys server, e.g. "http://127.0.0.1:4000". */
  baseUrl: string;
  sessionId: string;
  // Used for accent lookup by callers; the controller itself does not read this field.
  serverId?: string;
  /** Omitted only for a loopback server explicitly started with --no-auth. */
  token?: string;
  /** Initial size, normally measured by `FitAddon` before opening the socket. */
  cols: number;
  rows: number;
  readonly?: boolean;
  lossy?: boolean;
  terminal: TerminalLike;
  createSocket: SocketFactory;
  /**
   * The bundled client protocol version (CLIENT.md 4.3), injected by the
   * caller rather than imported here: this module is deliberately DOM-free
   * *and* package-free so it stays runnable straight from Node (see the
   * file header) - `@pty-server/protocol`'s package.json points `exports` at its
   * `.ts` sources with `.js`-extension internal imports, which only a
   * bundler (Vite) resolves, not Node's native TS type-stripping used by
   * the root test harness. When omitted, protocol mismatch detection on
   * the `ready` frame is skipped (no false positive).
   */
  clientProtocolVersion?: number;
  onReady?: (dims: AttachDims) => void;
  onResized?: (dims: AttachDims) => void;
  onProtocolMismatch?: (serverProtocol: number) => void;
  onExit?: (info: AttachExitInfo) => void;
  onError?: (reason: string) => void;
  /** Fired on any socket close, including the server's post-exit close. */
  onClose?: (event: { code: number; reason: string }) => void;
  /** Fired when a reconnect is scheduled (before the timer starts). */
  onReconnectScheduled?: (info: { attempt: number; delayMs: number }) => void;
  /** Fired when the derived status value changes. */
  onStatus?: (status: AttachStatus) => void;
}

function toWsUrl(baseUrl: string, sessionId: string, cols: number, rows: number, readonly?: boolean, lossy?: boolean): string {
  const url = new URL(`/v1/sessions/${sessionId}/attach`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cols", String(cols));
  url.searchParams.set("rows", String(rows));
  if (readonly) url.searchParams.set("readonly", "1");
  if (lossy) url.searchParams.set("lossy", "1");
  return url.toString();
}

// Distinguishes text (JSON control) frames from binary (raw pty bytes)
// frames purely by `event.data`'s type - matches how `binaryType:
// "arraybuffer"` behaves in both a real browser and `ws`.
function isBinaryPayload(data: unknown): data is ArrayBuffer {
  return typeof data !== "string";
}

export class AttachController {
  private readonly terminal: TerminalLike;
  private socket!: AttachSocket;
  private readonly options: AttachOptions;
  private readonly dataSubscription: AttachDisposable;
  private readonly binarySubscription: AttachDisposable;
  private snapshotReceived = false;
  private stateValue: AttachState = "connecting";
  private reconnectAttempt = 0;
  private reconnectScheduled = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private statusValue: AttachStatus = "online";

  constructor(options: AttachOptions) {
    this.options = options;
    this.terminal = options.terminal;
    this.openSocket();
    this.dataSubscription = this.terminal.onData((data) => this.handleTerminalData(data));
    this.binarySubscription = this.terminal.onBinary((data) => this.handleTerminalBinary(data));
  }

  get state(): AttachState {
    return this.stateValue;
  }

  get status(): AttachStatus {
    switch (this.stateValue) {
      case "attached":
        return "online";
      case "closed":
      case "exited":
        return "offline";
      case "connecting":
        return "reconnecting";
    }
  }

  /**
   * Call after a local pane resize (typically `FitAddon.fit()` changed
   * `terminal.cols`/`terminal.rows`). Sends the request; the terminal is
   * only actually resized once the server answers with `resized` (or
   * `ready`, on initial attach) - CLIENT.md section 7, last-writer-wins,
   * never reflow-fight the server.
   */
  resize(cols: number, rows: number): void {
    if (this.options.readonly) return;
    if (this.stateValue !== "attached" && this.stateValue !== "connecting") return;
    this.sendControl({ t: "resize", cols, rows });
  }

  close(): void {
    this.dataSubscription.dispose();
    this.binarySubscription.dispose();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stateValue !== "closed") {
      this.stateValue = "closed";
      this.socket.close();
    }
  }

  private openSocket(): void {
    const url = toWsUrl(this.options.baseUrl, this.options.sessionId, this.terminal.cols, this.terminal.rows, this.options.readonly, this.options.lossy);
    this.socket = this.options.createSocket(
      url,
      this.options.token === undefined ? [] : [`ptys.bearer.${this.options.token}`],
    );
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => this.handleOpen();
    this.socket.onmessage = (event) => this.handleMessage(event.data);
    this.socket.onclose = (event) => this.handleClose(event);
    this.socket.onerror = (event) => this.handleSocketError(event);
  }

  /**
   * An `error` control frame reconnects while the old socket is still live.
   * Silencing and closing it stops its frames reaching the terminal and stops
   * its close scheduling a second, competing reconnect.
   */
  private discardSocket(): void {
    const socket: AttachSocket | undefined = this.socket;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Already closing or closed.
    }
  }

  private handleOpen(): void {
    // Nothing to do: the server speaks first with `ready`.
  }

  private handleTerminalData(data: string): void {
    this.sendTerminalInput(new TextEncoder().encode(data));
  }

  private handleTerminalBinary(data: string): void {
    this.sendTerminalInput(binaryStringToBytes(data));
  }

  private sendTerminalInput(data: Uint8Array): void {
    if (this.options.readonly) return;
    // Frozen (exited) or already closed panes never send input.
    if (this.stateValue !== "attached") return;
    this.socket.send(data);
  }

  private sendControl(message: Record<string, unknown>): void {
    // A ResizeObserver can fire a resize before the socket finishes
    // connecting (the initial cols/rows already ride in the attach URL), and
    // sending on a CONNECTING/CLOSING socket throws InvalidStateError. Only
    // send when the socket is OPEN; a dropped pre-open resize is corrected by
    // the next fit after `ready`.
    if (this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(data: unknown): void {
    if (isBinaryPayload(data)) {
      this.handleBinary(data);
      return;
    }
    this.handleControl(data as string);
  }

  private handleBinary(data: ArrayBuffer): void {
    // First binary frame after (re)attach is the snapshot: it must land in
    // a fresh buffer, never appended to whatever the terminal already held.
    if (!this.snapshotReceived) {
      this.snapshotReceived = true;
      this.terminal.reset();
    }
    this.terminal.write(new Uint8Array(data));
  }

  private handleControl(raw: string): void {
    let message: { t?: string; [key: string]: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    switch (message.t) {
      case "ready": {
        const cols = message.cols as number;
        const rows = message.rows as number;
        const serverProtocol = message.protocol as number | undefined;
        this.reconnectAttempt = 0;
        this.stateValue = "attached";
        this.updateStatus();
        if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
          this.terminal.resize(cols, rows);
        }
        this.options.onReady?.({ cols, rows });
        if (
          serverProtocol !== undefined
          && this.options.clientProtocolVersion !== undefined
          && serverProtocol !== this.options.clientProtocolVersion
        ) {
          this.options.onProtocolMismatch?.(serverProtocol);
        }
        break;
      }
      case "resized": {
        const cols = message.cols as number;
        const rows = message.rows as number;
        if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
          this.terminal.resize(cols, rows);
        }
        this.options.onResized?.({ cols, rows });
        break;
      }
      case "exit": {
        this.stateValue = "exited";
        this.updateStatus();
        this.options.onExit?.({ code: message.code as number, signal: message.signal as number | undefined });
        break;
      }
      case "error": {
        this.options.onError?.(message.reason as string);
        this.beginReconnect();
        break;
      }
      default:
        break;
    }
  }

  private handleClose(event: { code: number; reason: string }): void {
    const wasActive = this.stateValue === "attached" || this.stateValue === "connecting";
    if (this.stateValue !== "exited") this.stateValue = "closed";
    this.options.onClose?.(event);
    if (wasActive) this.beginReconnect();
  }

  private handleSocketError(event: unknown): void {
    this.options.onError?.(event instanceof Error ? event.message : String(event));
  }

  private beginReconnect(): void {
    if (this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    this.stateValue = "connecting";
    this.updateStatus();
    this.snapshotReceived = false;
    const attempt = this.reconnectAttempt;
    const delay = computeReconnectDelayMs(this.reconnectAttempt++);
    this.options.onReconnectScheduled?.({ attempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => this.reconnectNow(), delay);
  }

  private reconnectNow(): void {
    this.reconnectTimer = null;
    this.reconnectScheduled = false;
    this.stateValue = "connecting";
    this.snapshotReceived = false;
    this.updateStatus();
    this.discardSocket();
    try {
      this.openSocket();
    } catch {
      // No socket exists, so no close event will arrive to drive the next
      // retry. Reschedule here or the controller stalls in "connecting".
      this.beginReconnect();
    }
  }

  private updateStatus(): void {
    const newStatus = this.status;
    if (newStatus !== this.statusValue) {
      this.statusValue = newStatus;
      this.options.onStatus?.(newStatus);
    }
  }
}
