import type { Session } from "@pty-server/protocol";
import { basename } from "../../registry/basename";

export const agentLabels: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function detectAgent(session: Session): string | undefined {
  if (session.exited !== undefined) return undefined;
  const candidates = [session.process, session.cmd, session.args[0]];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const label = agentLabels[basename(candidate)];
    if (label !== undefined) return label;
  }
  return undefined;
}
