import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const PERMISSION_SCRIPT = join(here, "scripts", "choux_permission_request.py");

const PTYS_MAX_BODY_BYTES = 65536;
const ENDPOINT = "http://127.0.0.1:1/v1/events";

let workDir;
let binDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "choux-claude-code-"));
  binDir = join(workDir, "bin");
  mkdirSync(binDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function fakePtys() {
  const path = join(binDir, "ptys");
  writeFileSync(path, `#!${process.execPath}
const fs = require("node:fs");
const dir = ${JSON.stringify(workDir)};
const calls = fs.existsSync(dir + "/calls.json") ? JSON.parse(fs.readFileSync(dir + "/calls.json", "utf8")) : [];
calls.push({ argv: process.argv.slice(2) });
fs.writeFileSync(dir + "/calls.json", JSON.stringify(calls));
process.stdout.write('{"answer":"allow"}');
`);
  chmodSync(path, 0o755);
}

function run(input) {
  return new Promise((resolve) => {
    const child = spawn("python3", [PERMISSION_SCRIPT], {
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: workDir,
        PYTHONDONTWRITEBYTECODE: "1",
        PTYS_EVENT_ENDPOINT: ENDPOINT,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

function calls() {
  const path = join(workDir, "calls.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

function emitted() {
  const [call] = calls();
  const payload = call.argv[call.argv.length - 1];
  return { payload, question: JSON.parse(payload) };
}

function editRequest(oldString, newString) {
  return JSON.stringify({
    session_id: "claude-session-1",
    hook_event_name: "PermissionRequest",
    cwd: "/workspace",
    tool_name: "Edit",
    tool_input: { file_path: "/workspace/test.md", old_string: oldString, new_string: newString },
  });
}

function lines(count, prefix) {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index}: ${"filler ".repeat(6)}`).join("\n");
}

describe("choux_permission_request.py diff sizing", () => {
  beforeEach(fakePtys);

  it("sends an ordinary edit whole instead of clipping it to a preview", async () => {
    const after = lines(200, "line");
    expect(after.length).toBeGreaterThan(4000);

    await run(editRequest("before", after));
    const [block] = emitted().question.data.blocks;

    expect(block.kind).toBe("diff");
    expect(block.after).toBe(after);
    expect(block.after).not.toContain("[preview truncated]");
  });

  it("keeps an oversized edit inside the body limit ptys enforces", async () => {
    const after = lines(20000, "line");
    expect(after.length).toBeGreaterThan(PTYS_MAX_BODY_BYTES);

    await run(editRequest("before", after));
    const { payload, question } = emitted();

    expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(PTYS_MAX_BODY_BYTES);
    expect(question.data.blocks[0].after).toContain("[preview truncated]");
    expect(question.data.blocks[0].after.length).toBeGreaterThan(20000);
  });

  it("keeps both sides inside the limit when each one alone would fit", async () => {
    const side = lines(4000, "line");

    await run(editRequest(side, side));
    const { payload, question } = emitted();

    expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(PTYS_MAX_BODY_BYTES);
    expect(question.data.blocks[0].before).toContain("[preview truncated]");
    expect(question.data.blocks[0].after).toContain("[preview truncated]");
    expect(question.data.blocks[0].before.length).toBeGreaterThan(10000);
    expect(question.data.blocks[0].after.length).toBeGreaterThan(10000);
  });

  it("still fits when escaping inflates the payload past its character count", async () => {
    const after = "\n\t\"\\".repeat(12000);

    await run(editRequest("before", after));
    const { payload, question } = emitted();

    expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(PTYS_MAX_BODY_BYTES);
    expect(question.data.blocks[0].after.length).toBeGreaterThan(10000);
  });

  it("never trims a diff below the size it used to be capped at", async () => {
    const after = lines(20000, "line");

    await run(editRequest("before", after));
    const [block] = emitted().question.data.blocks;

    expect(block.after.length).toBeGreaterThan(20000);
  });
});
