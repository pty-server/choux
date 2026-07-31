import type { Session } from "@pty-server/protocol";
import { basename } from "../../registry/basename";

export function isTmuxSession(session: Session): boolean {
  if (session.exited !== undefined) return false;
  return basename(session.process ?? session.cmd) === "tmux";
}
