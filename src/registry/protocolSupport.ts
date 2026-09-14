import {
  featureSupport,
  PROTOCOL_MINOR,
  PROTOCOL_VERSION,
  serverProtocolLevel,
  type FeatureSupport,
  type ServerInfo,
} from "@pty-server/protocol";

export type ProtocolInfo = Pick<ServerInfo, "protocol" | "protocolMinor">;

export function runnerSupport(info: ProtocolInfo | undefined): FeatureSupport | undefined {
  return info === undefined ? undefined : featureSupport(serverProtocolLevel(info), "runners");
}

export function workspaceDeleteSupport(info: ProtocolInfo | undefined): FeatureSupport | undefined {
  return info === undefined ? undefined : featureSupport(serverProtocolLevel(info), "workspaceDelete");
}

export function incompatibleServerMessage(info: ProtocolInfo): string {
  const server = serverProtocolLevel(info);
  const upgrade = server.major > PROTOCOL_VERSION ? "Upgrade Choux." : "Upgrade ptys on the server.";
  return `The server speaks protocol ${server.major}.${server.minor}, Choux speaks ${PROTOCOL_VERSION}.${PROTOCOL_MINOR}. ${upgrade}`;
}
