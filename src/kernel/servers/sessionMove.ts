import { sessionMoveSupport } from "../../registry/protocolSupport";
import type { ServerConn } from "../../registry/types";

export function sessionMoveBlocker(server: ServerConn | undefined): string | undefined {
  if (server?.status !== "online") return "The server is not connected.";
  if (sessionMoveSupport(server.info) !== "supported") return "Upgrade ptys on the server to move sessions.";
  return undefined;
}
