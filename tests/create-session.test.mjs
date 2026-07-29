// M5 gate: boots a real ptys server, creates a session via the new
// `createSession` API on the client API client, then attaches to it
// with `AttachController` driven into `@xterm/headless` over a real
// `ws` WebSocket - end-to-end proof that the new-session flow works.

import { test, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;
import { AttachController } from "../src/kernel/transport/attach.ts";

const cliPath = fileURLToPath(new URL("../../ptys/dist/cli.js", import.meta.url));
const token = "choux-create-session-token";
const origin = "http://localhost:5173";

let serverProc;
let baseUrl;
let workspaceId;

function pickPort() {
  return 40000 + Math.floor(Math.random() * 20000);
}

function isolatedHome() {
  return mkdtempSync(join(tmpdir(), "ptys-create-session-home-"));
}

export async function waitFor(predicate, timeoutMs = 5000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: timed out");
}

function startServer() {
  const port = pickPort();
  const host = "127.0.0.1";
  const proc = spawn(
    process.execPath,
    [cliPath, "server", "--listen", `${host}:${port}`, "--token", token, "--allow-origin", origin],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: isolatedHome(), PTYS_TEST_KICK: "1" } },
  );
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  return { proc, baseUrl: `http://${host}:${port}`, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitListening(handle) {
  await waitFor(() => (handle.stdout.includes("listening") ? true : undefined), 5000);
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { authorization: `Bearer ${token}`, "origin": origin, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  return body;
}

// Concatenates every buffer line's rendered text.
function bufferText(term) {
  const lines = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    const line = term.buffer.active.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

// Drives a real AttachController against a real session.
function drive(sessionId, { cols = 80, rows = 24, ...rest } = {}) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  const events = [];
  const controller = new AttachController({
    baseUrl,
    sessionId,
    token,
    cols,
    rows,
    terminal: term,
    createSocket: (url, protocols) => new WebSocket(url, protocols),
    onReady: (dims) => events.push({ type: "ready", ...dims }),
    onResized: (dims) => events.push({ type: "resized", ...dims }),
    onExit: (info) => events.push({ type: "exit", ...info }),
    onError: (reason) => events.push({ type: "error", reason }),
    onClose: (info) => events.push({ type: "close", ...info }),
    ...rest,
  });
  return { term, controller, events };
}

function waitForEvent(events, type, timeoutMs = 5000) {
  return waitFor(() => events.find((event) => event.type === type), timeoutMs);
}

beforeAll(async () => {
  const handle = startServer();
  serverProc = handle.proc;
  baseUrl = handle.baseUrl;
  await waitListening(handle);
  const cwd = mkdtempSync(join(tmpdir(), "ptys-create-session-workspace-"));
  const workspace = await apiFetch("/v1/workspaces", { method: "POST", body: { path: cwd } });
  workspaceId = workspace.id;
});

afterAll(() => {
  serverProc?.kill();
});

test("createSession API: creates a session with the expected shape", async () => {
  const { createApiClient } = await import("../src/kernel/transport/api.ts");
  const client = createApiClient({ baseUrl, token, headers: { Origin: origin } });

  const session = await client.createSession({
    workspaceId,
    cmd: "sh",
    args: ["-c", "stty -echo; printf 'M5-CREATED\\n'; cat; exit 5"],
    env: {},
    cols: 80,
    rows: 24,
    name: "m5-create-session",
  });

  assert.ok(typeof session.id === "string" && session.id.length > 0, "session.id should be a non-empty string");
  assert.equal(session.workspaceId, workspaceId);
  assert.equal(session.cmd, "sh");
  assert.equal(session.name, "m5-create-session");
  assert.equal(session.cols, 80);
  assert.equal(session.rows, 24);
  assert.deepEqual(session.args, ["-c", "stty -echo; printf 'M5-CREATED\\n'; cat; exit 5"]);
  assert.ok(typeof session.createdAt === "number");
});

test("createSession + attach: real session produces M5-CREATED output and exits with code 5", async () => {
  const { createApiClient } = await import("../src/kernel/transport/api.ts");
  const client = createApiClient({ baseUrl, token, headers: { Origin: origin } });

  const session = await client.createSession({
    workspaceId,
    cmd: "sh",
    args: ["-c", "stty -echo; printf 'M5-CREATED\\n'; cat; exit 5"],
    env: {},
    cols: 80,
    rows: 24,
    name: "m5-attach",
  });

  // Let the initial printf land before we attach.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const { term, controller, events } = drive(session.id);

  await waitForEvent(events, "ready");

  await waitFor(() => (bufferText(term).includes("M5-CREATED") ? true : undefined), 5000);
  assert.ok(bufferText(term).includes("M5-CREATED"), "buffer should contain M5-CREATED from real session output");

  // Feed EOF to end `cat`, which triggers `exit 5`.
  term.input("\x04", true);

  const exitEvent = await waitForEvent(events, "exit");
  assert.equal(exitEvent.code, 5, "session should exit with code 5");
  assert.equal(controller.state, "exited");

  controller.close();
});
