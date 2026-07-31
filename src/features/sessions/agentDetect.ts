import type { Session } from "@pty-server/protocol";
import { basename } from "../../registry/basename";

export const agentLabels: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function agentLabelFor(command: string | undefined): string | undefined {
  return command === undefined || command.length === 0 ? undefined : agentLabels[basename(command)];
}

export function detectAgent(session: Session): string | undefined {
  if (session.exited !== undefined) return undefined;
  for (const candidate of [session.process, session.cmd, session.args[0]]) {
    const label = agentLabelFor(candidate);
    if (label !== undefined) return label;
  }
  return undefined;
}
