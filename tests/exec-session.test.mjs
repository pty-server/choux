// Boots real ptys servers and drives `execSession` on the client API client.
// Covers both halves of the capability contract: a default server (exec is on)
// and one started with `--disable-exec`, where the route is never registered.

import { test, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../ptys/dist/cli.js", import.meta.url));
const token = "choux-exec-session-token";
const origin = "http://localhost:5173";

let enabled;
let disabled;

function pickPort() {
  return 40000 + Math.floor(Math.random() * 20000);
}

function isolatedHome() {
  return mkdtempSync(join(tmpdir(), "ptys-exec-session-home-"));
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

function startServer(extraFlags = []) {
  const port = pickPort();
  const host = "127.0.0.1";
  const proc = spawn(
    process.execPath,
    [cliPath, "server", "--listen", `${host}:${port}`, "--token", token, "--allow-origin", origin, ...extraFlags],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: isolatedHome(), PTYS_TEST_KICK: "1" } },
  );
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  return { proc, baseUrl: `http://${host}:${port}`, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function boot(extraFlags = []) {
  const handle = startServer(extraFlags);
  await waitFor(() => (handle.stdout.includes("listening") ? true : undefined), 5000);
  const { createApiClient } = await import("../src/kernel/transport/api.ts");
  const client = createApiClient({ baseUrl: handle.baseUrl, token, headers: { Origin: origin } });
  const cwd = mkdtempSync(join(tmpdir(), "ptys-exec-session-workspace-"));
  const workspace = await client.createWorkspace(cwd);
  return { handle, client, workspaceId: workspace.id, cwd };
}

// A session that stays alive so exec has a live context to run in.
function idleSession(client, workspaceId) {
  return client.createSession({
    workspaceId,
    cmd: "sh",
    args: ["-c", "cat"],
    env: {},
    cols: 80,
    rows: 24,
    name: "exec-host",
  });
}

beforeAll(async () => {
  [enabled, disabled] = await Promise.all([boot(), boot(["--disable-exec"])]);
});

afterAll(() => {
  enabled?.handle.proc.kill();
  disabled?.handle.proc.kill();
});

test("advertises the exec capability and runs a command in the session cwd", async () => {
  const info = await enabled.client.getInfo();
  assert.ok(info.capabilities?.includes("exec"), `expected exec capability, got ${JSON.stringify(info.capabilities)}`);

  const session = await idleSession(enabled.client, enabled.workspaceId);
  const result = await enabled.client.execSession(session.id, { cmd: "echo", args: ["hello-exec"] });

  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "hello-exec");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  // The session's spawn directory, which is the workspace realpath.
  assert.equal(result.cwd, session.cwd);
});

test("puts session introspection on the wire", async () => {
  const session = await idleSession(enabled.client, enabled.workspaceId);
  const listed = (await enabled.client.getSessions()).find((candidate) => candidate.id === session.id);

  assert.ok(Number.isInteger(listed.pid) && listed.pid > 0, `expected a pid, got ${listed.pid}`);
  assert.equal(typeof listed.cwd, "string");
  // The live foreground process of a `sh -c cat` session.
  assert.ok(typeof listed.process === "string" && listed.process.length > 0);
});

test("reports a command it cannot spawn as data, not as a failure", async () => {
  const session = await idleSession(enabled.client, enabled.workspaceId);
  const result = await enabled.client.execSession(session.id, { cmd: "choux-no-such-binary" });

  assert.equal(result.code, null);
  assert.ok(result.stderr.length > 0, "expected the spawn failure in stderr");
});

test("passes arguments without a shell", async () => {
  const session = await idleSession(enabled.client, enabled.workspaceId);
  const result = await enabled.client.execSession(session.id, { cmd: "echo", args: ["$HOME; rm -rf /"] });

  assert.equal(result.stdout.trim(), "$HOME; rm -rf /");
});

test("refuses exec for an exited session", async () => {
  const session = await enabled.client.createSession({
    workspaceId: enabled.workspaceId,
    cmd: "sh",
    args: ["-c", "exit 0"],
    env: {},
    cols: 80,
    rows: 24,
    name: "exec-exited",
  });
  await waitFor(async () => {
    const listed = (await enabled.client.getSessions()).find((candidate) => candidate.id === session.id);
    return listed?.exited === undefined ? undefined : true;
  });

  await assert.rejects(
    () => enabled.client.execSession(session.id, { cmd: "echo", args: ["nope"] }),
    (error) => error.status === 409,
  );
});

test("--disable-exec removes the route and the capability", async () => {
  const info = await disabled.client.getInfo();
  assert.deepEqual(info.capabilities, [], `expected no capabilities, got ${JSON.stringify(info.capabilities)}`);

  const session = await idleSession(disabled.client, disabled.workspaceId);

  await assert.rejects(
    () => disabled.client.execSession(session.id, { cmd: "echo", args: ["hello"] }),
    (error) => error.status === 404,
  );
});
