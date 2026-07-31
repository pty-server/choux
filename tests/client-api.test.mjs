import { test } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../ptys/dist/cli.js", import.meta.url));
const origin = "http://localhost:5173";

function pickPort() { return 20000 + Math.floor(Math.random() * 20000); }
function isolatedHome() { return mkdtempSync(join(tmpdir(), "ptys-test-home-")); }

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor: timed out");
}

function startServer(args, { home } = {}) {
  const port = pickPort();
  const fullArgs = ["server", "--listen", `127.0.0.1:${port}`, ...args];
  const proc = spawn(process.execPath, [cliPath, ...fullArgs], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home ?? isolatedHome() },
  });
  let stdout = "";
  proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  return { proc, baseUrl: `http://127.0.0.1:${port}`, get stdout() { return stdout; } };
}

async function waitListening(handle) {
  await waitFor(() => handle.stdout.includes("listening") ? true : undefined);
}

async function apiFetch(baseUrl, path, { token, method, body } = {}) {
  const headers = { origin };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function createSession(baseUrl, token, workspaceId, overrides = {}) {
  const result = await apiFetch(baseUrl, "/v1/sessions", {
    token, method: "POST", body: { workspaceId, cmd: "cat", args: [], env: {}, cols: 80, rows: 24, ...overrides },
  });
  assert.equal(result.status, 200);
  return result.body;
}

test("choux API client fetches typed CORS API data from a real server", async () => {
  const token = "choux-client-api-token";
  const handle = startServer(["--token", token, "--allow-origin", origin]);
  await waitListening(handle);

  try {
    const workspace = await apiFetch(handle.baseUrl, "/v1/workspaces", {
      token, method: "POST", body: { path: mkdtempSync(join(tmpdir(), "ptys-choux-workspace-")) },
    });
    assert.equal(workspace.status, 200);
    const session = await createSession(handle.baseUrl, token, workspace.body.id, { name: "client-api" });

    const { createApiClient } = await import("../src/kernel/transport/api.ts");
    const client = createApiClient({ baseUrl: handle.baseUrl, token, headers: { Origin: origin } });
    const [info, workspaces, sessions] = await Promise.all([client.getInfo(), client.getWorkspaces(), client.getSessions()]);

    assert.equal(typeof info.version, "string");
    assert.equal(typeof info.protocol, "number");
    assert.equal(typeof info.serverId, "string");
    assert.equal(typeof info.uptime, "number");
    assert.equal(typeof info.sessions, "number");
    assert.equal(typeof info.user, "string");
    assert.equal(typeof info.workspaces, "number");
    assert.ok(workspaces.some((item) => item.id === workspace.body.id));
    assert.ok(sessions.length > 0);
    assert.deepEqual(
      sessions.find((item) => item.id === session.id),
      { ...session, workspaceId: workspace.body.id, cmd: "cat", args: [], name: "client-api", cols: 80, rows: 24 },
    );

    const renamed = await client.updateSession(session.id, "renamed client API");
    assert.equal(renamed.name, "renamed client API");

    await client.deleteSession(session.id);
    const exited = await waitFor(async () => {
      const current = (await client.getSessions()).find((item) => item.id === session.id);
      return current?.exited === undefined ? undefined : current;
    });
    assert.equal(typeof exited.exited.at, "number");

    await client.deleteSession(session.id);
    await waitFor(async () => {
      const current = (await client.getSessions()).find((item) => item.id === session.id);
      return current === undefined ? true : undefined;
    });

    const cors = await apiFetch(handle.baseUrl, "/v1/info", { token });
    assert.equal(cors.headers.get("access-control-allow-origin"), origin);

    const directories = await client.listDirectories();
    assert.ok(Array.isArray(directories.entries));
  } finally {
    handle.proc.kill();
  }
});
