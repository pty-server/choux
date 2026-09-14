import type { Session } from "@pty-server/protocol";
import { cwdFieldValue } from "./cwdField";

const shellSafeWord = /^[A-Za-z0-9_.@%+=:,/-]+$/;

export function sessionLocation(session: Pick<Session, "cwd">, root: string): string {
  return cwdFieldValue(session.cwd, root) || ".";
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function sessionState(session: Pick<Session, "createdAt" | "exited">, now: number): string {
  if (!session.exited) return `up ${formatDuration(now - session.createdAt)}`;
  const signal = session.exited.signal ? `, signal ${session.exited.signal}` : "";
  return `exit ${session.exited.code}${signal}`;
}

export function runnerStartCommand(workspaceName: string): string {
  const quoted = shellSafeWord.test(workspaceName) ? workspaceName : `'${workspaceName.replace(/'/g, "'\\''")}'`;
  return `ptys start --workspace ${quoted} npm run dev`;
}
