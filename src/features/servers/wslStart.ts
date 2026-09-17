import { validTransport } from "../../registry/serverTransport";
import type { ServerStatus } from "../../registry/types";
import type { WslDistro, WslTransport } from "../../registry/wsl";

export interface StartableServer {
  readonly status: ServerStatus;
  readonly config: { readonly transport?: unknown };
}

export function stoppedWslTransport(
  server: StartableServer,
  distros: readonly WslDistro[],
): WslTransport | undefined {
  if (server.status === "online") return undefined;
  const transport = validTransport(server.config.transport);
  if (transport?.kind !== "wsl") return undefined;
  const distro = distros.find((candidate) => candidate.name === transport.distro);
  return distro !== undefined && !distro.running ? transport : undefined;
}

export const SERVER_START_ATTEMPTS = 30;
export const SERVER_START_INTERVAL_MS = 500;

export async function waitUntilOnline(
  status: () => ServerStatus | undefined,
  refresh: () => void,
  attempts = SERVER_START_ATTEMPTS,
  intervalMs = SERVER_START_INTERVAL_MS,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    refresh();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (status() === "online") return true;
  }
  return false;
}
