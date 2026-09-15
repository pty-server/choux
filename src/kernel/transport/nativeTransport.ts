import { isTauriRuntime, type TauriInvoke } from "../storage/tokenStore";
import type { ServerTransport } from "../../registry/serverTransport";
import type { AttachSocket } from "./attach";
import type { EventSocket } from "./events";

export interface NativeHttpResponse {
  status: number;
  statusText: string;
  body: string;
}

export type RequestLane = "shared" | "dedicated";

interface NativeSocketEvent {
  type: "open" | "text" | "binary" | "close" | "error";
  data?: string;
  code?: number;
  reason?: string;
}

function eventId(): string {
  return `ptys-native-${crypto.randomUUID()}`;
}

function plainTarget(target: ServerTransport): ServerTransport {
  return { ...target };
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new Error("Native ptys connections are available only in the desktop app.");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return (tauriInvoke as TauriInvoke)<T>(command, args);
}

export async function nativeRequest(
  target: ServerTransport,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; lane?: RequestLane } = {},
): Promise<NativeHttpResponse> {
  return invoke<NativeHttpResponse>("ptys_request", {
    target: plainTarget(target),
    path,
    method: init.method,
    headers: init.headers,
    body: init.body,
    lane: init.lane,
  });
}

export async function retainNativeTransport(target: ServerTransport): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("ptys_transport_retain", { target: plainTarget(target) });
}

export async function releaseNativeTransport(target: ServerTransport): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("ptys_transport_release", { target: plainTarget(target) });
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function bytesToBase64(value: ArrayBufferLike | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class NativeSocket implements AttachSocket, EventSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private connectionId: string | undefined;
  private closed = false;
  private unlisten: (() => void) | undefined;

  constructor(target: ServerTransport, path: string, protocols: string[]) {
    void this.open(plainTarget(target), path, protocols);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.connectionId === undefined || this.readyState !== 1) return;
    const payload = typeof data === "string" ? { text: data } : { binary: bytesToBase64(data) };
    void invoke("ptys_socket_send", { connectionId: this.connectionId, ...payload }).catch((error) => this.fail(error));
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.unlisten?.();
    this.unlisten = undefined;
    if (this.connectionId !== undefined) {
      void invoke("ptys_socket_close", { connectionId: this.connectionId, code, reason });
    }
  }

  private async open(target: ServerTransport, path: string, protocols: string[]): Promise<void> {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const channel = eventId();
      const unlisten = await listen<NativeSocketEvent>(channel, (event) => this.handle(event.payload));
      if (this.closed) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      const connectionId = await invoke<string>("ptys_socket_open", { target, path, protocols, channel });
      if (this.closed) {
        void invoke("ptys_socket_close", { connectionId });
        return;
      }
      this.connectionId = connectionId;
    } catch (error) {
      this.fail(error);
    }
  }

  private handle(event: NativeSocketEvent): void {
    if (this.closed && event.type !== "close") return;
    switch (event.type) {
      case "open":
        this.readyState = 1;
        this.onopen?.();
        return;
      case "text":
        this.onmessage?.({ data: event.data ?? "" });
        return;
      case "binary":
        this.onmessage?.({ data: base64ToArrayBuffer(event.data ?? "") });
        return;
      case "close":
        this.closed = true;
        this.readyState = 3;
        this.unlisten?.();
        this.unlisten = undefined;
        this.onclose?.({ code: event.code ?? 1006, reason: event.reason ?? "" });
        return;
      case "error":
        this.fail(event.data ?? "The ptys connection failed.");
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.onerror?.(error);
    this.handle({ type: "close", code: 1006, reason: error instanceof Error ? error.message : String(error) });
  }
}

export function nativeSocketFactory(target: ServerTransport): (url: string, protocols: string[]) => NativeSocket {
  return (url, protocols) => {
    const { pathname, search } = new URL(url);
    return new NativeSocket(target, `${pathname}${search}`, protocols);
  };
}
