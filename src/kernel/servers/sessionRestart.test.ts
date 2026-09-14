import type { Session } from "@pty-server/protocol";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../transport/api";
import { restartSession } from "./sessionRestart";

const timing = { stopTimeoutMs: 600, pollMs: 200 };

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "old",
    workspaceId: "w1",
    name: "dev",
    cmd: "npm",
    args: ["run", "dev"],
    env: { PORT: "5173" },
    cols: 120,
    rows: 40,
    followSize: false,
    createdAt: 1,
    pid: 10,
    cwd: "/src/shop/web",
    ...overrides,
  };
}

const running = session();
const exited = session({ exited: { code: 143, at: 2 } });

function steps(polls: Array<Session | undefined>) {
  const calls: string[] = [];
  let poll = 0;
  return {
    calls,
    getSession: vi.fn(async () => {
      calls.push("get");
      return polls[Math.min(poll++, polls.length - 1)];
    }),
    signal: vi.fn(async (id: string, signal: string) => {
      calls.push(`${signal} ${id}`);
    }),
    createSession: vi.fn(async () => {
      calls.push("create");
      return session({ id: "new", pid: 11 });
    }),
    deleteSession: vi.fn(async (id: string) => {
      calls.push(`delete ${id}`);
    }),
    wait: vi.fn(async () => {}),
  };
}

describe("restartSession", () => {
  it("stops a running session, starts an identical one and then removes the old one", async () => {
    const run = steps([running, exited]);

    const replacement = await restartSession(running, run, timing);

    expect(replacement.id).toBe("new");
    expect(run.calls).toEqual(["SIGTERM old", "get", "get", "create", "delete old"]);
    expect(run.createSession).toHaveBeenCalledWith({
      workspaceId: "w1",
      cwd: "/src/shop/web",
      cmd: "npm",
      args: ["run", "dev"],
      env: { PORT: "5173" },
      name: "dev",
      cols: 120,
      rows: 40,
      followSize: false,
    });
  });

  it("escalates to SIGKILL when SIGTERM does not stop the session in time", async () => {
    const run = steps([running, running, running, exited]);

    await restartSession(running, run, timing);

    expect(run.calls).toEqual(["SIGTERM old", "get", "get", "get", "SIGKILL old", "get", "create", "delete old"]);
  });

  it("creates nothing when even SIGKILL does not stop the session", async () => {
    const run = steps([running]);

    await expect(restartSession(running, run, timing)).rejects.toThrow("dev did not stop");
    expect(run.createSession).not.toHaveBeenCalled();
    expect(run.deleteSession).not.toHaveBeenCalled();
  });

  it("restarts an exited session without signalling it", async () => {
    const run = steps([]);

    await restartSession(exited, run, timing);

    expect(run.calls).toEqual(["create", "delete old"]);
  });

  it("treats a session that disappeared as stopped and tolerates it being gone on removal", async () => {
    const run = steps([undefined]);
    run.deleteSession.mockRejectedValue(new ApiError("session not found", 404));

    await expect(restartSession(running, run, timing)).resolves.toMatchObject({ id: "new" });
  });

  it("keeps the old session when the new one cannot start", async () => {
    const run = steps([exited]);
    run.createSession.mockRejectedValue(new Error("cwd does not exist"));

    await expect(restartSession(running, run, timing)).rejects.toThrow("cwd does not exist");
    expect(run.deleteSession).not.toHaveBeenCalled();
  });

  it("does not swallow failures other than a missing session", async () => {
    const run = steps([exited]);
    run.signal.mockRejectedValue(new ApiError("forbidden", 403));

    await expect(restartSession(running, run, timing)).rejects.toThrow("forbidden");
    expect(run.createSession).not.toHaveBeenCalled();
  });
});
