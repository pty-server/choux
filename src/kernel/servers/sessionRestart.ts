import type { Session } from "@pty-server/protocol";
import { ApiError, type CreateSessionBody } from "../transport/api";

export interface RestartSteps {
  getSession: (id: string) => Promise<Session | undefined>;
  signal: (id: string, signal: string) => Promise<void>;
  createSession: (body: CreateSessionBody) => Promise<Session>;
  deleteSession: (id: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
}

export interface RestartTiming {
  stopTimeoutMs: number;
  pollMs: number;
}

const defaultTiming: RestartTiming = { stopTimeoutMs: 5000, pollMs: 200 };

async function waitForExit(id: string, steps: RestartSteps, timing: RestartTiming): Promise<boolean> {
  for (let waited = 0; waited < timing.stopTimeoutMs; waited += timing.pollMs) {
    await steps.wait(timing.pollMs);
    const current = await steps.getSession(id);
    if (current === undefined || current.exited !== undefined) return true;
  }
  return false;
}

async function ignoreMissing(action: Promise<void>): Promise<void> {
  try {
    await action;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}

async function stop(session: Session, steps: RestartSteps, timing: RestartTiming): Promise<void> {
  await ignoreMissing(steps.signal(session.id, "SIGTERM"));
  if (await waitForExit(session.id, steps, timing)) return;
  await ignoreMissing(steps.signal(session.id, "SIGKILL"));
  if (await waitForExit(session.id, steps, timing)) return;
  const label = session.name || [session.cmd, ...session.args].join(" ");
  throw new Error(`${label} did not stop, so it was not restarted.`);
}

export async function restartSession(session: Session, steps: RestartSteps, timing: RestartTiming = defaultTiming): Promise<Session> {
  if (session.exited === undefined) await stop(session, steps, timing);
  const replacement = await steps.createSession({
    workspaceId: session.workspaceId,
    cwd: session.cwd,
    cmd: session.cmd,
    args: session.args,
    env: session.env,
    name: session.name,
    cols: session.cols,
    rows: session.rows,
    followSize: session.followSize,
  });
  await ignoreMissing(steps.deleteSession(session.id));
  return replacement;
}
