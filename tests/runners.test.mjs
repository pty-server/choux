import { test, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiClient } from "../src/kernel/transport/api.ts";
import { openHomeProject } from "../src/kernel/servers/localAutostart.ts";
import { restartSession } from "../src/kernel/servers/sessionRestart.ts";

const cliPath = fileURLToPath(new URL("../../ptys/dist/cli.js", import.meta.url));
const token = "choux-runners-token";
const origin = "http://localhost:5173";
const spawned = [];

let shared;

function pickPort() {
  return 20000 + Math.floor(Math.random() * 40000);
}

function tempDirectory(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: timed out");
}

function isolatedEnv(home) {
  const env = { ...process.env, HOME: home };
  for (const name of Object.keys(env)) {
    if (name.startsWith("PTYS_") || name === "XDG_RUNTIME_DIR") delete env[name];
  }
  return env;
}

async function boot() {
  const home = tempDirectory("choux-runners-home-");
  const port = pickPort();
  const proc = spawn(
    process.execPath,
    [cliPath, "server", "--listen", `127.0.0.1:${port}`, "--token", token, "--allow-origin", origin],
    { stdio: ["ignore", "pipe", "pipe"], env: isolatedEnv(home) },
  );
  spawned.push(proc);
  let stdout = "";
  proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  proc.stderr.resume();
  await waitFor(() => (stdout.includes("listening") ? true : undefined));
  const client = createApiClient({ baseUrl: `http://127.0.0.1:${port}`, token, headers: { Origin: origin } });
  return { home, client };
}

function sessionBody(workspaceId, overrides = {}) {
  return { workspaceId, cmd: "cat", args: [], cols: 80, rows: 24, ...overrides };
}

beforeAll(async () => {
  shared = await boot();
});

afterAll(() => {
  for (const proc of spawned) proc.kill();
});

test("a runner and a project can share one directory", async () => {
  const root = tempDirectory("choux-runners-root-");

  const project = await shared.client.createWorkspace({ path: root });
  const runner = await shared.client.createWorkspace({ path: root, kind: "runner", name: "shop stack" });

  assert.equal(project.kind, "project");
  assert.equal(runner.kind, "runner");
  assert.equal(runner.name, "shop stack");
  assert.notEqual(project.id, runner.id);
  const listed = await shared.client.getWorkspaces();
  assert.ok(listed.some((workspace) => workspace.id === project.id && workspace.realpath === root));
  assert.ok(listed.some((workspace) => workspace.id === runner.id && workspace.kind === "runner"));
});

test("sessions start at the root, in a relative directory and in an absolute one", async () => {
  const root = tempDirectory("choux-runners-root-");
  const outside = tempDirectory("choux-runners-outside-");
  mkdirSync(join(root, "packages", "web"), { recursive: true });
  const runner = await shared.client.createWorkspace({ path: root, kind: "runner" });

  const atRoot = await shared.client.createSession(sessionBody(runner.id));
  const relative = await shared.client.createSession(sessionBody(runner.id, { cwd: "packages/web" }));
  const absolute = await shared.client.createSession(sessionBody(runner.id, { cwd: outside }));

  assert.equal(atRoot.cwd, root);
  assert.equal(relative.cwd, join(root, "packages", "web"));
  assert.equal(absolute.cwd, outside);
});

test("a missing cwd and a file cwd are rejected", async () => {
  const root = tempDirectory("choux-runners-root-");
  writeFileSync(join(root, "notes.txt"), "");
  const runner = await shared.client.createWorkspace({ path: root, kind: "runner" });

  await assert.rejects(
    shared.client.createSession(sessionBody(runner.id, { cwd: "missing" })),
    (error) => error.status === 400 && /cwd does not exist/.test(error.message),
  );
  await assert.rejects(
    shared.client.createSession(sessionBody(runner.id, { cwd: "notes.txt" })),
    (error) => error.status === 400 && /not a directory/.test(error.message),
  );
});

test("browsing scoped to a workspace starts at its root, even outside the browse roots", async () => {
  const root = tempDirectory("choux-runners-root-");
  mkdirSync(join(root, "alpha"));
  const runner = await shared.client.createWorkspace({ path: root, kind: "runner" });

  const listing = await shared.client.listDirectories(undefined, undefined, undefined, runner.id);
  assert.equal(listing.current?.path, root);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["alpha"]);

  const nested = await shared.client.listDirectories(join(root, "alpha"), undefined, undefined, runner.id);
  assert.equal(nested.current?.path, join(root, "alpha"));

  await assert.rejects(
    shared.client.listDirectories(undefined, undefined, undefined, "no-such-workspace"),
    (error) => error.status === 404,
  );
});

test("stopping a runner session signals it until it exits", async () => {
  const runner = await shared.client.createWorkspace({ path: tempDirectory("choux-runners-root-"), kind: "runner" });
  const session = await shared.client.createSession(sessionBody(runner.id));

  await shared.client.signalSession(session.id, "SIGTERM");

  const stopped = await waitFor(async () => (await shared.client.getSessions(runner.id))
    .find((candidate) => candidate.id === session.id && candidate.exited !== undefined));
  assert.ok(stopped.exited);
});

test("restarting a running runner session replaces it with an identical one", async () => {
  const root = tempDirectory("choux-runners-root-");
  mkdirSync(join(root, "web"));
  const runner = await shared.client.createWorkspace({ path: root, kind: "runner" });
  const original = await shared.client.createSession(sessionBody(runner.id, { cwd: "web", name: "dev", env: { CHOUX_RUNNER: "1" } }));

  const replacement = await restartSession(original, {
    getSession: async (id) => (await shared.client.getSessions(runner.id)).find((candidate) => candidate.id === id),
    signal: shared.client.signalSession,
    createSession: shared.client.createSession,
    deleteSession: shared.client.deleteSession,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }, { stopTimeoutMs: 3000, pollMs: 50 });

  assert.notEqual(replacement.id, original.id);
  assert.equal(replacement.exited, undefined);
  assert.equal(replacement.cwd, join(root, "web"));
  assert.equal(replacement.cmd, "cat");
  assert.equal(replacement.name, "dev");
  assert.equal(replacement.env.CHOUX_RUNNER, "1");
  assert.deepEqual((await shared.client.getSessions(runner.id)).map((candidate) => candidate.id), [replacement.id]);
});

test("closing a workspace is refused while a session runs and takes its exited sessions along", async () => {
  const runner = await shared.client.createWorkspace({ path: tempDirectory("choux-runners-root-"), kind: "runner" });
  const session = await shared.client.createSession(sessionBody(runner.id));

  await assert.rejects(shared.client.deleteWorkspace(runner.id), (error) => error.status === 409);

  await shared.client.signalSession(session.id, "SIGKILL");
  await waitFor(async () => (await shared.client.getSessions(runner.id))
    .find((candidate) => candidate.id === session.id && candidate.exited !== undefined));
  await shared.client.deleteWorkspace(runner.id);

  assert.ok(!(await shared.client.getWorkspaces()).some((workspace) => workspace.id === runner.id));
  assert.ok(!(await shared.client.getSessions()).some((candidate) => candidate.id === session.id));
  await assert.rejects(shared.client.deleteWorkspace(runner.id), (error) => error.status === 404);
});

test("local autostart opens exactly one home project with one session on a fresh server", async () => {
  const fresh = await boot();
  let created;

  await openHomeProject({
    getInfo: fresh.client.getInfo,
    home: async () => fresh.home,
    createWorkspace: fresh.client.createWorkspace,
    startSession: (workspaceId) => {
      created = fresh.client.createSession({ workspaceId, cols: 80, rows: 24 });
    },
  });
  const session = await created;

  const workspaces = await fresh.client.getWorkspaces();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].kind, "project");
  assert.equal(workspaces[0].realpath, fresh.home);
  assert.equal(session.workspaceId, workspaces[0].id);
  assert.equal((await fresh.client.getSessions()).length, 1);
});
