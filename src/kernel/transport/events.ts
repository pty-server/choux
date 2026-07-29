import type { EventControl, EventEnvelope, EventInput } from "@pty-server/protocol";
import { computeReconnectDelayMs } from "./attach";

/** Structural subset shared by browser WebSocket and test doubles. */
export interface EventSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type EventSocketFactory = (url: string, protocols: string[]) => EventSocket;

export interface EventStreamOptions {
  baseUrl: string;
  /** Omitted only for a loopback server explicitly started with --no-auth. */
  token?: string;
  createSocket: EventSocketFactory;
  onEvent: (event: EventControl) => void;
  random?: () => number;
}

export function eventStreamUrl(baseUrl: string): string {
  const url = new URL("/v1/events", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEvent(raw: unknown): EventControl | undefined {
  if (typeof raw !== "string") return undefined;

  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || message.t !== "event" || !isRecord(message.event)) return undefined;

  const event = message.event;
  if (
    typeof event.sessionId !== "string"
    || typeof event.type !== "string"
    || !Object.hasOwn(event, "data")
  ) return undefined;

  const envelope: EventEnvelope = { sessionId: event.sessionId, type: event.type, data: event.data };
  const hasRequestId = Object.hasOwn(message, "requestId");
  const hasTtl = Object.hasOwn(message, "ttl");
  if (!hasRequestId && !hasTtl) return { t: "event", event: envelope };
  if (
    !hasRequestId
    || !hasTtl
    || typeof message.requestId !== "string"
    || message.requestId.length === 0
    || typeof message.ttl !== "number"
    || !Number.isFinite(message.ttl)
    || message.ttl < 0
  ) return undefined;
  return { t: "event", event: envelope, requestId: message.requestId, ttl: message.ttl };
}

/**
 * Maintains one connection to ptys' global session-event stream and can send
 * correlated replies for supported request events.
 */
export class EventStreamController {
  private readonly options: EventStreamOptions;
  private socket: EventSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private reconnectScheduled = false;
  private closed = false;

  constructor(options: EventStreamOptions) {
    this.options = options;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectScheduled = false;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  reply(requestId: string, event: EventInput): boolean {
    const socket = this.socket;
    if (this.closed || socket === undefined || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify({ t: "event.reply", requestId, event }));
      return true;
    } catch {
      return false;
    }
  }

  private open(): void {
    if (this.closed) return;

    let socket: EventSocket;
    try {
      socket = this.options.createSocket(
        eventStreamUrl(this.options.baseUrl),
        this.options.token === undefined ? [] : [`ptys.bearer.${this.options.token}`],
      );
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.closed) return;
      this.reconnectAttempt = 0;
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.closed) return;
      const parsed = parseEvent(event.data);
      if (parsed !== undefined) this.options.onEvent(parsed);
    };
    socket.onclose = () => {
      if (this.socket !== socket || this.closed) return;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      if (this.socket !== socket || this.closed) return;
      socket.close();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    const delay = computeReconnectDelayMs(this.reconnectAttempt++, this.options.random);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectScheduled = false;
      this.open();
    }, delay);
  }
}
