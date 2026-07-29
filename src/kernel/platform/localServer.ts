import { isTauriRuntime, type TauriInvoke } from "../storage/tokenStore";

export interface LocalServerCandidate {
  instance: string;
  /** TCP listeners are informational only; Choux always uses the control socket. */
  listen?: string[];
}

export interface LocalServerTool {
  available: boolean;
  npmAvailable: boolean;
  executable?: string;
  message?: string;
}

export interface LocalServerCommandResult {
  ok: boolean;
  message?: string;
}

export interface LocalServerBridge {
  candidates(): Promise<LocalServerCandidate[]>;
  tool(): Promise<LocalServerTool>;
  install(): Promise<LocalServerCommandResult>;
  start(): Promise<LocalServerCommandResult>;
}

function normalizeResult(value: LocalServerCommandResult): LocalServerCommandResult {
  return { ok: value.ok, message: value.message };
}

/** Native-only command surface for same-user daemon discovery and launch. */
export async function getLocalServerBridge(): Promise<LocalServerBridge | undefined> {
  if (!isTauriRuntime()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  const call = invoke as TauriInvoke;
  return {
    candidates: () => call<LocalServerCandidate[]>("local_server_candidates"),
    tool: () => call<LocalServerTool>("local_server_tool"),
    install: async () => normalizeResult(await call<LocalServerCommandResult>("local_server_install")),
    start: async () => normalizeResult(await call<LocalServerCommandResult>("local_server_start")),
  };
}

/** A stable placeholder URL for code paths that require a URL but use native transport. */
export function localServerEndpoint(instance: string): string {
  return `http://${instance}.ptys.local`;
}
