import type { Workspace } from "@pty-server/protocol";
import type { ServerConn, ServerStatus } from "../../registry/types";

export type TileStatus = "online" | "warn" | "offline";

export interface RailTile {
  key: string;
  serverId: string;
  workspace: Workspace;
  serverLabel: string;
  accent: string;
  status: TileStatus;
}

export interface RailGroup {
  serverId: string;
  tiles: RailTile[];
}

export interface RailModel {
  groups: RailGroup[];
  showDividers: boolean;
}

export function tileStatus(status: ServerStatus): TileStatus {
  if (status === "online") return "online";
  if (status === "connecting") return "warn";
  return "offline";
}

export function buildRailModel(servers: ServerConn[]): RailModel {
  const groups = servers.flatMap((server) => {
    if (server.workspaces.length === 0) return [];
    const serverId = server.config.id;
    const tiles = server.workspaces.map((workspace) => ({
      key: `${serverId}:${workspace.id}`,
      serverId,
      workspace,
      serverLabel: server.config.label,
      accent: server.config.accent,
      status: tileStatus(server.status),
    }));
    return [{ serverId, tiles }];
  });

  return { groups, showDividers: groups.length > 1 };
}
