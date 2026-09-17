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
