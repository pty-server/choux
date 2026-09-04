import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(pluginRoot, "..", "..");

const STATE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const marketplace = readJson(join(repoRoot, ".claude-plugin", "marketplace.json"));
const plugin = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
const hooks = readJson(join(pluginRoot, "hooks", "hooks.json")).hooks;

function commandsFor(event) {
  return (hooks[event] ?? []).flatMap((group) => group.hooks).map((hook) => hook.command);
}

function scriptFor(command) {
  const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/.exec(command);
  return match === null ? undefined : match[1];
}

const allCommands = Object.keys(hooks).flatMap(commandsFor);

describe("marketplace", () => {
  it("lists the plugin under the name the plugin claims", () => {
    const entry = marketplace.plugins.find((candidate) => candidate.name === plugin.name);
    expect(entry).toBeDefined();
  });

  it("points at a directory holding the plugin manifest", () => {
    for (const entry of marketplace.plugins) {
      expect(existsSync(join(repoRoot, entry.source, ".claude-plugin", "plugin.json"))).toBe(true);
    }
  });

  it("pins no version, so updates track the commit", () => {
    expect(plugin.version).toBeUndefined();
    for (const entry of marketplace.plugins) expect(entry.version).toBeUndefined();
  });
});

describe("hooks", () => {
  it("reports state on every lifecycle event", () => {
    for (const event of STATE_EVENTS) {
      const scripts = commandsFor(event).map(scriptFor);
      expect(scripts).toContain("scripts/choux_agent_state.py");
    }
  });

  it("bridges permission requests alongside the state report", () => {
    const scripts = commandsFor("PermissionRequest").map(scriptFor);
    expect(scripts).toContain("scripts/choux_permission_request.py");
    expect(scripts).toContain("scripts/choux_agent_state.py");
  });

  it("resolves every script through the plugin root", () => {
    for (const command of allCommands) {
      expect(command).toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(existsSync(join(pluginRoot, scriptFor(command)))).toBe(true);
    }
  });

  it("gives the permission bridge room to outlive its own answer timeout", () => {
    const bridge = hooks.PermissionRequest.flatMap((group) => group.hooks)
      .find((hook) => scriptFor(hook.command) === "scripts/choux_permission_request.py");
    expect(bridge.timeout).toBeGreaterThan(60);
  });
});
