import { isTauriRuntime, type TauriInvoke } from "../storage/tokenStore";
import type { AttachSocket } from "./attach";
import type { EventSocket } from "./events";

export interface LocalHttpResponse {
  status: number;
  statusText: string;
  body: string;
}

interface LocalSocketEvent {
  type: "open" | "text" | "binary" | "close" | "error";
  data?: string;
  code?: number;
  reason?: string;
}

function eventId(): string {
  return `ptys-local-${crypto.randomUUID()}`;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new Error("Local ptys sockets are available only in the desktop app.");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return (tauriInvoke as TauriInvoke)<T>(command, args);
}

/** Performs one HTTP request over a verified ptys control socket. */
export async function localPtysRequest(
  instance: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<LocalHttpResponse> {
  return invoke<LocalHttpResponse>("local_server_request", {
    instance,
    path,
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
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

/** Browser-WebSocket-shaped adapter backed by a native Unix-socket WebSocket. */
export class LocalPtysSocket implements AttachSocket, EventSocket {
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private connectionId: string | undefined;
  private closed = false;
  private unlisten: (() => void) | undefined;

  constructor(instance: string, path: string, protocols: string[]) {
    void this.open(instance, path, protocols);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.connectionId === undefined || this.readyState !== 1) return;
    const payload = typeof data === "string" ? { text: data } : { binary: bytesToBase64(data) };
    void invoke("local_socket_send", { connectionId: this.connectionId, ...payload }).catch((error) => this.fail(error));
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.unlisten?.();
    this.unlisten = undefined;
    if (this.connectionId !== undefined) {
      void invoke("local_socket_close", { connectionId: this.connectionId, code, reason });
    }
  }

  private async open(instance: string, path: string, protocols: string[]): Promise<void> {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const channel = eventId();
      this.unlisten = await listen<LocalSocketEvent>(channel, (event) => this.handle(event.payload));
      if (this.closed) return;
      this.connectionId = await invoke<string>("local_socket_open", { instance, path, protocols, channel });
    } catch (error) {
      this.fail(error);
    }
  }

  private handle(event: LocalSocketEvent): void {
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
        this.fail(event.data ?? "Local ptys socket failed.");
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.onerror?.(error);
    this.handle({ type: "close", code: 1006, reason: error instanceof Error ? error.message : String(error) });
  }
}

export function localPtysSocket(instance: string, path: string, protocols: string[]): LocalPtysSocket {
  return new LocalPtysSocket(instance, path, protocols);
}
