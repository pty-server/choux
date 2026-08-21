import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const PERMISSION_SCRIPT = join(here, "choux_permission_request.py");
const STATE_SCRIPT = join(here, "choux_agent_state.py");

let workDir;
let binDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "choux-codex-"));
  binDir = join(workDir, "bin");
  mkdirSync(binDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function shim(name, body) {
  const path = join(binDir, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
}

/** `ptys` stand-in: records the endpoint it was handed and replays a scripted reply
 * per attempt, so endpoint ordering and retry are observable. */
function fakePtys(attempts) {
  writeFileSync(join(workDir, "plan.json"), JSON.stringify(attempts));
  shim("ptys", `
const fs = require("node:fs");
const dir = ${JSON.stringify(workDir)};
const calls = fs.existsSync(dir + "/calls.json") ? JSON.parse(fs.readFileSync(dir + "/calls.json", "utf8")) : [];
calls.push({ argv: process.argv.slice(2), endpoint: process.env.PTYS_EVENT_ENDPOINT });
fs.writeFileSync(dir + "/calls.json", JSON.stringify(calls));
const plan = JSON.parse(fs.readFileSync(dir + "/plan.json", "utf8"));
const step = plan[calls.length - 1] ?? { exit: 1 };
if (step.hang) { setTimeout(() => {}, 600000); } else {
  if (step.stdout) process.stdout.write(step.stdout);
  process.exit(step.exit ?? 0);
}
`);
}

function fakeTmux(value) {
  shim("tmux", `
if (process.argv[2] === "show-environment") process.stdout.write("PTYS_EVENT_ENDPOINT=" + ${JSON.stringify(value)} + "\\n");
`);
}

function calls() {
  const path = join(workDir, "calls.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

function run(script, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("python3", [script], {
      env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: workDir, PYTHONDONTWRITEBYTECODE: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const bashRequest = {
  session_id: "codex-session-1",
  hook_event_name: "PermissionRequest",
  cwd: "/workspace",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
};

function question() {
  const [call] = calls();
  return JSON.parse(call.argv[call.argv.length - 1]);
}

function decision(stdout) {
  return JSON.parse(stdout).hookSpecificOutput;
}

describe("choux_permission_request.py", () => {
  it("leaves Codex to its own prompt when no endpoint is set", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest));

    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(calls()).toEqual([]);
  });

  it("falls back on malformed hook input", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    const result = await run(PERMISSION_SCRIPT, "not json", { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(result.stdout).toBe("");
    expect(calls()).toEqual([]);
  });

  it("falls back when ptys is not installed", async () => {
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(result).toMatchObject({ code: 0, stdout: "" });
  });

  it("falls back when ptys exits non-zero", async () => {
    fakePtys([{ exit: 1 }]);
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(result.stdout).toBe("");
  });

  it("falls back when the request outlasts its timeout", async () => {
    fakePtys([{ hang: true }]);
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), {
      PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events",
      CHOUX_QUESTION_TIMEOUT_SECONDS: "1",
    });

    expect(result).toMatchObject({ code: 0, stdout: "" });
    // Empty output alone would also pass if the question were never asked at all.
    expect(calls()).toHaveLength(1);
  });

  it("spends its whole budget on the question rather than rounding it away", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), {
      PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events",
      CHOUX_QUESTION_TIMEOUT_SECONDS: "1",
    });

    const [call] = calls();
    expect(call.argv[call.argv.indexOf("--timeout") + 1]).toBe("1");
  });

  it("falls back when Choux cancels the question", async () => {
    fakePtys([{ exit: 0, stdout: '{"cancelled":true}' }]);
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(result.stdout).toBe("");
  });

  it("falls back on a malformed or unknown reply", async () => {
    fakePtys([{ exit: 0, stdout: "]" }]);
    expect((await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" })).stdout).toBe("");

    rmSync(join(workDir, "calls.json"), { force: true });
    fakePtys([{ exit: 0, stdout: '{"answer":"allow-always"}' }]);
    expect((await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" })).stdout).toBe("");
  });

  it("turns an allow answer into the Codex allow decision", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(decision(result.stdout)).toEqual({ hookEventName: "PermissionRequest", decision: { behavior: "allow" } });
  });

  it("turns a deny answer into the Codex deny decision", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"deny"}' }]);
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(decision(result.stdout)).toEqual({ hookEventName: "PermissionRequest", decision: { behavior: "deny" } });
  });

  it("passes a denial note back as the reason Codex is given", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"deny","note":"run it in CI instead"}' }]);
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(decision(result.stdout).decision).toEqual({ behavior: "deny", message: "run it in CI instead" });
  });

  it("never returns a reserved output field", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(result.stdout).not.toMatch(/updatedPermissions|updatedInput|interrupt/);
    expect(question().data.options.map((option) => option.id)).toEqual(["allow", "deny"]);
  });

  it("sends a Bash request as a command block without a guessed working directory", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    const { data } = question();
    expect(data.blocks).toEqual([{ kind: "command", command: "npm test" }]);
    expect(data.title).toBe("Run a command");
  });

  it("renders apply_patch updates as the same native diff blocks used by Claude Code", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"deny"}' }]);
    const patch = `*** Begin Patch
*** Update File: src/app.ts
@@
-const port = 3000
+const port = 8080
*** Add File: src/ready.ts
+export const ready = true;
*** End of File
*** Delete File: obsolete.txt
*** End Patch`;
    const target = join(workDir, "untouched.txt");
    writeFileSync(target, "original");
    await run(PERMISSION_SCRIPT, JSON.stringify({
      ...bashRequest,
      tool_name: "apply_patch",
      tool_input: { command: patch },
    }), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(question().data.blocks).toEqual([
      { kind: "diff", path: "src/app.ts", before: "const port = 3000", after: "const port = 8080" },
      { kind: "diff", path: "src/ready.ts", before: "", after: "export const ready = true;" },
      { kind: "fields", title: "Delete a file", fields: [{ label: "File", value: "obsolete.txt" }] },
    ]);
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  it("falls back to a clipped raw patch when its envelope is not recognised", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"deny"}' }]);
    const patch = `*** Begin Patch\n${"x".repeat(9000)}\n*** End Patch`;
    await run(PERMISSION_SCRIPT, JSON.stringify({
      ...bashRequest,
      tool_name: "apply_patch",
      tool_input: { command: patch },
    }), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    const [block] = question().data.blocks;
    expect(block).toMatchObject({ kind: "command", badges: ["patch"] });
    expect(block.command.length).toBeLessThan(patch.length);
    expect(block.command).toContain("[truncated]");
  });

  it("sends an unknown structured tool as allowlisted fields", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    await run(PERMISSION_SCRIPT, JSON.stringify({
      ...bashRequest,
      tool_name: "spawn_agent",
      tool_input: { task_name: "review", objective: "check the diff", secret_blob: "x".repeat(50000) },
    }), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    const { data } = question();
    expect(data.blocks).toEqual([{
      kind: "fields",
      fields: [{ label: "Task", value: "review" }, { label: "Objective", value: "check the diff" }],
    }]);
    expect(JSON.stringify(data)).not.toContain("secret_blob");
  });

  it("clips a request that has nothing on the allowlist", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    await run(PERMISSION_SCRIPT, JSON.stringify({
      ...bashRequest,
      tool_name: "weird_mcp_tool",
      tool_input: { blob: "y".repeat(50000) },
    }), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    const { data } = question();
    expect(data.message).toContain("weird_mcp_tool");
    expect(data.message).toContain("[truncated]");
    expect(data.message.length).toBeLessThan(5000);
  });

  it("attributes the question to the Codex run without inventing a tool-use id", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(question().data.origin).toEqual({ agent: "codex", agentSessionId: "codex-session-1", tool: "Bash" });
  });

  it("prefers the tmux-tracked endpoint over the inherited one", async () => {
    fakePtys([{ exit: 0, stdout: '{"answer":"allow"}' }]);
    fakeTmux("http+unix:/live.sock:/v1/events");
    await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), {
      TMUX: "/tmp/tmux-1000/default,1,0",
      PTYS_EVENT_ENDPOINT: "http+unix:/stale.sock:/v1/events",
    });

    expect(calls().map((call) => call.endpoint)).toEqual(["http+unix:/live.sock:/v1/events"]);
  });

  it("retries the inherited endpoint when the tmux one fails", async () => {
    fakePtys([{ exit: 1 }, { exit: 0, stdout: '{"answer":"allow"}' }]);
    fakeTmux("http+unix:/dead.sock:/v1/events");
    const result = await run(PERMISSION_SCRIPT, JSON.stringify(bashRequest), {
      TMUX: "/tmp/tmux-1000/default,1,0",
      PTYS_EVENT_ENDPOINT: "http+unix:/live.sock:/v1/events",
    });

    expect(calls().map((call) => call.endpoint)).toEqual(["http+unix:/dead.sock:/v1/events", "http+unix:/live.sock:/v1/events"]);
    expect(decision(result.stdout).decision).toEqual({ behavior: "allow" });
  });
});

describe("hooks.json", () => {
  const config = JSON.parse(readFileSync(join(here, "hooks.json"), "utf8"));
  const entries = (event) => (config.hooks[event] ?? []).flatMap((group) => group.hooks);
  const commands = (event) => entries(event).map((hook) => hook.command);
  const scriptOf = (command) => command.split(" ").at(-1).split("/").at(-1);

  const LIFECYCLE = [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
    "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop", "SessionEnd",
  ];

  it("wires exactly the Codex lifecycle events, and no invented ones", () => {
    expect(Object.keys(config.hooks).sort()).toEqual([...LIFECYCLE].sort());
  });

  it("reports state on every one of them", () => {
    for (const event of LIFECYCLE) {
      expect(commands(event).map(scriptOf), event).toContain("choux_agent_state.py");
    }
  });

  it("carries both handlers on PermissionRequest, and the bridge nowhere else", () => {
    expect(commands("PermissionRequest").map(scriptOf)).toEqual(["choux_agent_state.py", "choux_permission_request.py"]);

    for (const event of LIFECYCLE.filter((name) => name !== "PermissionRequest")) {
      expect(commands(event).map(scriptOf), event).not.toContain("choux_permission_request.py");
    }
  });

  it("keeps both PermissionRequest handlers in one matching group", () => {
    expect(config.hooks.PermissionRequest).toHaveLength(1);
  });

  it("names only scripts that this directory ships", () => {
    for (const event of LIFECYCLE) {
      for (const command of commands(event)) {
        expect(command.startsWith("python3 ~/.codex/hooks/"), command).toBe(true);
        expect(existsSync(join(here, scriptOf(command))), command).toBe(true);
      }
    }
  });

  it("gives the blocking bridge room to outlast the question it asks", () => {
    const [reporter, bridge] = entries("PermissionRequest");

    expect(bridge.timeout).toBeGreaterThan(60);
    expect(reporter.timeout).toBeLessThanOrEqual(5);
  });

  it("respects Codex's three-second SessionEnd timeout ceiling", () => {
    expect(entries("SessionEnd")[0].timeout).toBe(3);
  });

  it("omits the matcher only where Codex ignores it", () => {
    for (const [event, groups] of Object.entries(config.hooks)) {
      for (const group of groups) {
        expect(group.matcher, event).toBe(["UserPromptSubmit", "Stop"].includes(event) ? undefined : "*");
      }
    }
  });

  it("keeps status reporting and permission decisions synchronous", () => {
    expect(JSON.stringify(config)).not.toContain('"async"');
  });
});

function collector() {
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return { received, server };
}

function listenOn(server, target) {
  return new Promise((resolve) => server.listen(target, () => resolve(server.address())));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe("choux_agent_state.py", () => {
  const promptEvent = {
    session_id: "codex-session-1",
    hook_event_name: "UserPromptSubmit",
    cwd: "/workspace",
    prompt: "ship it",
  };

  async function report(request, env = {}) {
    const { received, server } = collector();
    const address = await listenOn(server, 0);
    const endpoint = `http://127.0.0.1:${address.port}/v1/events`;
    const result = await run(STATE_SCRIPT, JSON.stringify(request), { PTYS_EVENT_ENDPOINT: endpoint, ...env });
    await close(server);
    return { result, received, endpoint };
  }

  it("sends the required envelope as a plain notification", async () => {
    const { result, received } = await report(promptEvent);

    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(received).toHaveLength(1);
    expect(received[0].body).toMatchObject({ type: "choux.agent.state", request: false });
    expect(received[0].body.data).toMatchObject({ agent: "codex", event: "UserPromptSubmit", cwd: "/workspace" });
    expect(typeof received[0].body.data.at).toBe("number");
  });

  it("attributes the state to a pane, session, tool and tool call", async () => {
    const { received } = await report({
      ...promptEvent,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "call_42",
      tool_input: { command: "npm test" },
    }, { TMUX_PANE: "%3" });

    expect(received[0].body.data).toMatchObject({
      pane: "%3",
      agentSessionId: "codex-session-1",
      tool: "Bash",
      toolUseId: "call_42",
      detail: "npm test",
    });
  });

  it("clips the detail and never serializes an unknown input wholesale", async () => {
    const { received } = await report({
      ...promptEvent,
      hook_event_name: "PreToolUse",
      tool_name: "weird_mcp_tool",
      tool_input: { path: "p".repeat(900), blob: "z".repeat(50000) },
    });

    const { data } = received[0].body;
    expect(data.detail.length).toBeLessThanOrEqual(257);
    expect(JSON.stringify(data)).not.toContain("blob");
    expect(JSON.stringify(data)).not.toContain("zzz");
  });

  it("names the blocking tool while a permission request is open", async () => {
    const { received } = await report({
      ...promptEvent,
      hook_event_name: "PermissionRequest",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch" },
    });

    expect(received[0].body.data.message).toBe("Codex needs your approval to use apply_patch");
  });

  it("delivers over a Unix control socket", async () => {
    const socketPath = join(workDir, "control.sock");
    const { received, server } = collector();
    await listenOn(server, socketPath);
    const result = await run(STATE_SCRIPT, JSON.stringify(promptEvent), {
      PTYS_EVENT_ENDPOINT: `http+unix:${socketPath}:/v1/events`,
    });
    await close(server);

    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(received[0]).toMatchObject({ path: "/v1/events" });
  });

  it("prefers the tmux endpoint and falls back to the inherited one", async () => {
    const { received, server } = collector();
    const address = await listenOn(server, 0);
    const live = `http://127.0.0.1:${address.port}/v1/events`;

    fakeTmux(live);
    await run(STATE_SCRIPT, JSON.stringify(promptEvent), {
      TMUX: "/tmp/tmux-1000/default,1,0",
      PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events",
    });
    expect(received).toHaveLength(1);

    fakeTmux("http://127.0.0.1:1/v1/events");
    await run(STATE_SCRIPT, JSON.stringify(promptEvent), {
      TMUX: "/tmp/tmux-1000/default,1,0",
      PTYS_EVENT_ENDPOINT: live,
    });
    expect(received).toHaveLength(2);

    await close(server);
  });

  it("stays silent when the endpoint rejects the event", async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(401);
      response.end();
    });
    const address = await listenOn(server, 0);
    const result = await run(STATE_SCRIPT, JSON.stringify(promptEvent), {
      PTYS_EVENT_ENDPOINT: `http://127.0.0.1:${address.port}/v1/events`,
    });
    await close(server);

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("stays silent when nothing is listening", async () => {
    const result = await run(STATE_SCRIPT, JSON.stringify(promptEvent), { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" });

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("stays silent on malformed input and on an event without a name", async () => {
    expect(await run(STATE_SCRIPT, "not json", { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" }))
      .toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await run(STATE_SCRIPT, "{}", { PTYS_EVENT_ENDPOINT: "http://127.0.0.1:1/v1/events" }))
      .toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("never starts a ptys process for a status event", async () => {
    fakePtys([{ exit: 0 }]);
    await report(promptEvent);

    expect(calls()).toEqual([]);
  });
});
