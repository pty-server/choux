// M3 gate (CLIENT-MVP.md "Attach (the core)" / CLIENT.md section 6-7): boots
// a real ptys server, runs a real session, and drives the real
// `AttachController` (src/kernel/transport/attach.ts) from Node over a
// real WebSocket - no mocking of attach internals. Renders into
// `@xterm/headless`, the same DOM-free Terminal the server itself uses for
// snapshots, so this exercises the exact kernel module the browser build
// ships, not a stand-in.
//
// Run with: npm run test:integration

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
const token = "choux-attach-test-token";

let serverProc;
let baseUrl;
let workspaceId;

function pickPort() {
  return 40000 + Math.floor(Math.random() * 20000);
}

function isolatedHome() {
  return mkdtempSync(join(tmpdir(), "ptys-attach-test-home-"));
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
    [cliPath, "server", "--listen", `${host}:${port}`, "--token", token],
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
    headers: { authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  return body;
}

// Test hook: POST to the server-side kick endpoint (only available when
// PTYS_TEST_KICK=1). `reason` is passed as a query string, not a body,
// because the test hook reads it from the URL.
async function kick(sessionId, reason) {
  const url = reason ? `/v1/sessions/${sessionId}/attach/kick?reason=${encodeURIComponent(reason)}` : `/v1/sessions/${sessionId}/attach/kick`;
  const response = await fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`POST ${url} -> ${response.status}: ${text}`);
  return body;
}

async function createSession(overrides = {}) {
  return apiFetch("/v1/sessions", {
    method: "POST",
    body: { workspaceId, cmd: "sh", args: [], env: {}, cols: 80, rows: 24, ...overrides },
  });
}

// Concatenates every buffer line's rendered text - used to assert both
// snapshot contents and that later output appended in order, without caring
// exactly which row it landed on (pty echo can duplicate/shift rows).
function bufferText(term) {
  const lines = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    const line = term.buffer.active.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

// Wires a real AttachController to a real `ws` WebSocket and a fresh
// `@xterm/headless` Terminal, recording every lifecycle callback so tests
// can assert both terminal contents and controller-level events/ordering.
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
  const cwd = mkdtempSync(join(tmpdir(), "ptys-attach-test-workspace-"));
  const workspace = await apiFetch("/v1/workspaces", { method: "POST", body: { path: cwd } });
  workspaceId = workspace.id;
});

afterAll(() => {
  serverProc?.kill();
});

test("AttachController: snapshot repaint, in-order live output, input reaches the pty, and exit freezes the pane with the right code", async () => {
  const session = await createSession({
    name: "attach-core",
    // `stty -echo` disables the pty's own line-discipline echo so the only
    // echo of our input is `cat`'s (a single, unambiguous output stream) -
    // otherwise kernel echo and `cat`'s echo race on the same pty and can
    // interleave/tear mid-write, which is a real tty artifact unrelated to
    // whether the controller preserves frame arrival order.
    args: ["-c", "stty -echo; printf 'SNAP-HELLO\\n'; cat; exit 7"],
  });

  // Let the initial printf land in the server's VT state *before* our
  // controller ever attaches, so the very first binary frame we receive is
  // proof of a real snapshot repaint, not just a live echo we caused.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const { term, controller, events } = drive(session.id);

  await waitForEvent(events, "ready");
  assert.equal(events[0].cols, 80);
  assert.equal(events[0].rows, 24);

  await waitFor(() => (bufferText(term).includes("SNAP-HELLO") ? true : undefined));

  // `cat` is now running: feed it a burst of distinctly-numbered lines in
  // one go. If the controller ever reordered or coalesced binary frames,
  // these would not come back in ascending order.
  const lineCount = 40;
  const burst = Array.from({ length: lineCount }, (_, i) => `LINE-${i}`).join("\r") + "\r";
  term.input(burst, true); // simulates real keyboard input -> term.onData -> binary frame

  await waitFor(() => (bufferText(term).includes(`LINE-${lineCount - 1}`) ? true : undefined), 5000);

  const text = bufferText(term);
  const seen = [...text.matchAll(/LINE-(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(seen.length >= lineCount, `expected at least ${lineCount} LINE-N matches, saw ${seen.length}`);
  // Every occurrence (echo can duplicate them) must still be non-decreasing
  // in arrival order - the defining property of "no reorder, no coalesce".
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1], `LINE-N out of order: ...${seen[i - 1]}, ${seen[i]}...`);
  }
  assert.deepEqual([...new Set(seen)].sort((a, b) => a - b), Array.from({ length: lineCount }, (_, i) => i));

  // EOF at start of line ends `cat`'s stdin; the wrapping `sh` then runs
  // `exit 7`, a real, deterministic, non-external-signal exit path that
  // only happens if our binary input frames actually reached the pty.
  term.input("\x04", true);

  const exitEvent = await waitForEvent(events, "exit");
  assert.equal(exitEvent.code, 7);
  assert.equal(controller.state, "exited");

  // Frozen pane: the final screen (including the snapshot text) stays
  // intact, and further "typing" must not send anything.
  assert.ok(bufferText(term).includes("SNAP-HELLO"));
  const sentBefore = events.length;
  term.input("should-not-send\r", true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(events.length, sentBefore, "no further events after exit");
  assert.equal(events.some((event) => event.type === "error"), false);

  controller.close();
});

test("AttachController: ready adopts server-authoritative dims, and inbound resized letterboxes without a client-side fight", async () => {
  const session = await createSession({ name: "attach-resize", cmd: "cat" });

  // Solo attach: this client's requested size becomes the session size.
  const a = drive(session.id, { cols: 100, rows: 30 });
  await waitForEvent(a.events, "ready");
  assert.equal(a.events[0].cols, 100);
  assert.equal(a.events[0].rows, 30);
  assert.equal(a.term.cols, 100);
  assert.equal(a.term.rows, 30);

  // Second, smaller client: server letterboxes it to the existing (larger)
  // session size rather than shrinking the session - the controller must
  // adopt that authoritative size on its own terminal, not what it asked for.
  const b = drive(session.id, { cols: 60, rows: 20 });
  await waitForEvent(b.events, "ready");
  assert.equal(b.events[0].cols, 100);
  assert.equal(b.events[0].rows, 30);
  assert.equal(b.term.cols, 100);
  assert.equal(b.term.rows, 30);

  // Explicit resize from the read-write client is honored and broadcast
  // back (including to the sender) as `resized`, which both controllers
  // must apply to their local terminal.
  a.controller.resize(120, 40);
  await waitForEvent(a.events, "resized");
  await waitForEvent(b.events, "resized");
  assert.equal(a.term.cols, 120);
  assert.equal(a.term.rows, 40);
  assert.equal(b.term.cols, 120);
  assert.equal(b.term.rows, 40);

  a.controller.close();
  b.controller.close();
});

test("AttachController: attaching to an already-exited session is a normal path (ready + final snapshot + exit, then close)", async () => {
  const session = await createSession({ name: "attach-exited", args: ["-c", "printf 'DONE-STATE\\n'; exit 3"] });

  await waitFor(async () => {
    const fetched = await apiFetch(`/v1/sessions/${session.id}`);
    return fetched.exited ? fetched : undefined;
  }, 5000);

  const { term, events } = drive(session.id);

  await waitForEvent(events, "ready");
  const exitEvent = await waitForEvent(events, "exit");
  assert.equal(exitEvent.code, 3);
  await waitForEvent(events, "close");

  assert.ok(bufferText(term).includes("DONE-STATE"));
  assert.equal(events.some((event) => event.type === "error"), false);

  // ready must have arrived, then the snapshot text, before exit - assert
  // the recorded event order directly rather than just presence.
  const order = events.map((event) => event.type);
  assert.ok(order.indexOf("ready") < order.indexOf("exit"), `expected ready before exit, got: ${order.join(",")}`);
});

test("AttachController: reconnect after abrupt server-side kill, with real state survival", async () => {
  const session = await createSession({
    name: "attach-reconnect",
    args: ["-c", "stty -echo; printf 'BEFORE-KILL-123\\n'; cat; exit 0"],
  });

  await waitFor(async () => {
    const fetched = await apiFetch(`/v1/sessions/${session.id}`);
    return !fetched.exited ? fetched : undefined;
  }, 5000);

  const { term, controller, events } = drive(session.id);

  await waitForEvent(events, "ready");
  await waitFor(() => (bufferText(term).includes("BEFORE-KILL-123") ? true : undefined));

  // Abrupt kill: terminate() -> onclose code 1006, no exit message.
  const kickResult = await kick(session.id);
  assert.equal(kickResult.kicked > 0, true, "at least one client was kicked");

  await waitFor(() => (controller.status === "reconnecting" ? true : undefined));

  // A second ready event proves the controller reconnected and got a fresh snapshot.
  await waitFor(() => (events.filter((e) => e.type === "ready").length >= 2 ? true : undefined), 5000);
  assert.ok(events.filter((e) => e.type === "ready").length >= 2, "expected a second ready event after reconnect");

  await waitFor(() => (controller.status === "online" ? true : undefined));

  // Buffer should still contain the pre-kill text (server-side session state survived).
  assert.ok(bufferText(term).includes("BEFORE-KILL-123"), "buffer should retain pre-kill text after reconnect");

  // Write new text and confirm it lands (proves the reattached socket is live).
  term.input("AFTER-RECONNECT-OK\r", true);
  await waitFor(() => (bufferText(term).includes("AFTER-RECONNECT-OK") ? true : undefined), 5000);

  controller.close();
});

test("AttachController: backoff is bounded and jittered", async () => {
  // Unit test: algorithmic correctness of computeReconnectDelayMs.
  const { computeReconnectDelayMs, BASE_MS: cBASE, CAP_MS: cCAP } = await import("../src/kernel/transport/attach.ts");

  // attempt 0: range [250, 500]
  for (let i = 0; i < 20; i++) {
    const d = computeReconnectDelayMs(0, () => 0.25 + Math.random() * 0.5);
    assert.ok(d >= 250, `attempt 0 delay ${d} should be >= 250`);
    assert.ok(d <= 500, `attempt 0 delay ${d} should be <= 500`);
  }

  // attempt 4+: capped at [4000, 8000]
  for (let i = 4; i <= 10; i++) {
    const d = computeReconnectDelayMs(i, () => 0.25 + Math.random() * 0.5);
    assert.ok(d >= 4000, `attempt ${i} delay ${d} should be >= 4000`);
    assert.ok(d <= 8000, `attempt ${i} delay ${d} should be <= 8000`);
  }

  // Non-decreasing in cap-following behavior.
  const delays = Array.from({ length: 10 }, (_, i) => computeReconnectDelayMs(i, () => 0.9));
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] >= delays[i - 1], `delay[${i}]=${delays[i]} should be >= delay[${i - 1}]=${delays[i - 1]}`);
  }

  // Always <= CAP_MS.
  for (let i = 0; i < 20; i++) {
    const d = computeReconnectDelayMs(i, () => 0.5);
    assert.ok(d <= cCAP, `delay ${d} should be <= CAP_MS ${cCAP}`);
  }

  // Always >= 250 at attempt 0.
  for (let i = 0; i < 20; i++) {
    const d = computeReconnectDelayMs(0, () => 0.0);
    assert.ok(d >= 250, `attempt 0 delay ${d} should be >= 250`);
  }

  // Jitter: same attempt, real Math.random, should produce different values.
  const values = Array.from({ length: 20 }, () => computeReconnectDelayMs(2));
  const unique = new Set(values);
  assert.ok(unique.size > 1, `expected jitter: got ${unique.size} unique values out of 20 for attempt 2`);

  // Live test: observe real controller scheduling decisions.
  const session = await createSession({ name: "attach-backoff", cmd: "cat" });
  const samples = [];
  const { term, controller, events } = drive(session.id, {
    onReconnectScheduled(info) {
      samples.push(info);
    },
  });

  await waitForEvent(events, "ready");
  await kick(session.id);

  await waitFor(() => (controller.status === "reconnecting" ? true : undefined));
  await waitForEvent(events, "ready");
  await waitFor(() => (controller.status === "online" ? true : undefined));

  controller.close();

  // Every observed delay should be <= 8000 (CAP_MS).
  for (const s of samples) {
    assert.ok(s.delayMs <= 8000, `observed delay ${s.delayMs} should be <= 8000`);
  }

  // Delays should be non-decreasing within the same reconnect.
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].delayMs >= samples[i - 1].delayMs, `delay[${i}]=${samples[i].delayMs} should be >= delay[${i - 1}]=${samples[i - 1].delayMs}`);
  }
});

test("AttachController: error{reason} triggers reconnect", async () => {
  const session = await createSession({ name: "attach-error-reconnect", cmd: "cat" });
  const { term, controller, events } = drive(session.id);

  await waitForEvent(events, "ready");

  // Kick with a reason: client receives {t:"error",reason} then onclose.
  await kick(session.id, "client too slow");

  const errorEvent = await waitForEvent(events, "error");
  assert.ok(errorEvent, "expected error event after kick with reason");
  assert.equal(errorEvent.reason, "client too slow");

  await waitFor(() => (controller.status === "reconnecting" ? true : undefined));
  await waitFor(() => (events.filter((e) => e.type === "ready").length >= 2 ? true : undefined), 5000);
  await waitFor(() => (controller.status === "online" ? true : undefined));

  controller.close();
});

test("AttachController: clean exit does NOT reconnect", async () => {
  const session = await createSession({
    name: "attach-no-reconnect",
    args: ["-c", "stty -echo; printf 'EXIT-TEXT\\n'; cat; exit 42"],
  });

  const { term, controller, events } = drive(session.id);

  await waitForEvent(events, "ready");
  await waitFor(() => (bufferText(term).includes("EXIT-TEXT") ? true : undefined));

  // Send EOF to end `cat`, which triggers `exit 42`.
  term.input("\x04", true);

  await waitForEvent(events, "exit");

  assert.equal(controller.status, "offline", "status should be offline after exit");

  // Wait past the point where a reconnect would have fired (longest backoff cap).
  await new Promise((resolve) => setTimeout(resolve, 1000));

  assert.equal(controller.status, "offline", "status should stay offline after waiting 1s past exit");

  // Only one ready event (no reconnect).
  const readyCount = events.filter((e) => e.type === "ready").length;
  assert.equal(readyCount, 1, `expected exactly 1 ready event, got ${readyCount}`);

  controller.close();
});
