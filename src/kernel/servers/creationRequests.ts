import type { CreateWorkspaceRequest } from "@pty-server/protocol";
import { incompatibleServerMessage, runnerSupport, type ProtocolInfo } from "../../registry/protocolSupport";
import type { CreateSessionBody } from "../transport/api";

export type GatedRequest<T> = { body: T } | { refusal: string };

export function gateSessionRequest(body: CreateSessionBody, info: ProtocolInfo | undefined): GatedRequest<CreateSessionBody> {
  if (info !== undefined && runnerSupport(info) === "incompatible") return { refusal: incompatibleServerMessage(info) };
  const { cwd, ...legacy } = body;
  return { body: runnerSupport(info) === "supported" && cwd ? { ...legacy, cwd } : legacy };
}

export function gateWorkspaceRequest(body: CreateWorkspaceRequest, info: ProtocolInfo | undefined): GatedRequest<CreateWorkspaceRequest> {
  if (info !== undefined && runnerSupport(info) === "incompatible") return { refusal: incompatibleServerMessage(info) };
  const { kind, name, ...legacy } = body;
  if (runnerSupport(info) !== "supported") return { body: legacy };
  return { body: { ...legacy, ...(kind ? { kind } : {}), ...(name ? { name } : {}) } };
}
