import type { CreateWorkspaceRequest, ServerInfo, Workspace } from "@pty-server/protocol";
import { incompatibleServerMessage, runnerSupport } from "../../registry/protocolSupport";

export interface HomeProjectSteps {
  getInfo: () => Promise<ServerInfo>;
  home: () => Promise<string | undefined>;
  createWorkspace: (body: CreateWorkspaceRequest) => Promise<Workspace>;
  startSession: (workspaceId: string | undefined) => void;
}

export async function openHomeProject({ getInfo, home, createWorkspace, startSession }: HomeProjectSteps): Promise<void> {
  const info = await getInfo();
  const support = runnerSupport(info);
  if (support === "incompatible") throw new Error(incompatibleServerMessage(info));
  if (support === "legacy") {
    startSession(undefined);
    return;
  }
  const path = await home();
  if (path === undefined) throw new Error("Choux could not find your home directory, so no session was started.");
  const workspace = await createWorkspace({ path, kind: "project" });
  startSession(workspace.id);
}
