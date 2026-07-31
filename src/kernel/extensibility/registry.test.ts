import type { Session } from "@pty-server/protocol";
import { describe, expect, it } from "vitest";
import type { SessionViewItem } from "../../registry/types";
import { createKernelRegistry } from "./registry.svelte";

const stubComponent = (() => {}) as unknown as SessionViewItem["component"];

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    workspaceId: "w1",
    cmd: "sh",
    args: [],
    env: {},
    cols: 80,
    rows: 24,
    createdAt: 1,
    pid: 100,
    cwd: "/w",
    ...overrides,
  };
}

describe("createKernelRegistry", () => {
  it("registers a command and resolves it by id", () => {
    const registry = createKernelRegistry();
    const command = { id: "cmd.foo", title: "Foo", run: () => {} };

    registry.registerCommand(command);

    expect(registry.getCommand("cmd.foo")).toBe(command);
  });

  it("lists registered commands", () => {
    const registry = createKernelRegistry();
    const a = { id: "cmd.a", title: "A", run: () => {} };
    const b = { id: "cmd.b", title: "B", run: () => {} };

    registry.registerCommand(a);
    registry.registerCommand(b);

    expect(registry.listCommands()).toEqual(expect.arrayContaining([a, b]));
    expect(registry.listCommands()).toHaveLength(2);
  });

  it("forgets an unregistered command, including through its chord", () => {
    const registry = createKernelRegistry();
    const command = { id: "cmd.foo", title: "Foo", run: () => {} };
    registry.registerCommand(command);
    registry.registerKeybinding("Mod+K", "cmd.foo");

    registry.unregisterCommand("cmd.foo");

    expect(registry.getCommand("cmd.foo")).toBeUndefined();
    expect(registry.listCommands()).toEqual([]);
    expect(registry.resolveKeybinding("Mod+K")).toBeUndefined();
  });

  it("registers a keybinding chord and resolves it to the bound command", () => {
    const registry = createKernelRegistry();
    const command = { id: "cmd.foo", title: "Foo", run: () => {} };
    registry.registerCommand(command);

    registry.registerKeybinding("Mod+K", "cmd.foo");

    expect(registry.resolveKeybinding("Mod+K")).toBe(command);
  });

  it("returns undefined when resolving an unregistered chord", () => {
    const registry = createKernelRegistry();

    expect(registry.resolveKeybinding("Mod+Shift+P")).toBeUndefined();
  });

  it("registers a chrome slot item and reads it back", () => {
    const registry = createKernelRegistry();
    const item = { id: "rail.sessions", component: {} };

    registry.registerRailItem(item);

    expect(registry.railItems).toContainEqual(item);
  });

  it("resolves the first matching session view in order", () => {
    const registry = createKernelRegistry();
    const specific: SessionViewItem = { id: "specific", order: 10, detect: () => true, component: stubComponent };
    const general: SessionViewItem = { id: "general", order: 20, detect: () => true, component: stubComponent };

    registry.registerSessionView(general);
    registry.registerSessionView(specific);

    expect(registry.resolveSessionView({ session: session() })).toBe(specific);
  });

  it("skips a session view whose detector declines", () => {
    const registry = createKernelRegistry();
    const declines: SessionViewItem = { id: "no", order: 10, detect: () => false, component: stubComponent };
    const accepts: SessionViewItem = { id: "yes", order: 20, detect: () => true, component: stubComponent };

    registry.registerSessionView(declines);
    registry.registerSessionView(accepts);

    expect(registry.resolveSessionView({ session: session() })).toBe(accepts);
  });

  it("passes the terminal title to detectors", () => {
    const registry = createKernelRegistry();
    registry.registerSessionView({
      id: "titled",
      detect: (context) => context.terminalTitle === "building",
      component: stubComponent,
    });

    expect(registry.resolveSessionView({ session: session(), terminalTitle: "building" })).toBeDefined();
    expect(registry.resolveSessionView({ session: session() })).toBeUndefined();
  });

  it("returns undefined when no session view matches", () => {
    const registry = createKernelRegistry();
    registry.registerSessionView({ id: "never", detect: () => false, component: stubComponent });

    expect(registry.resolveSessionView({ session: session() })).toBeUndefined();
  });

  it("forgets an unregistered session view", () => {
    const registry = createKernelRegistry();
    registry.registerSessionView({ id: "tmux", detect: () => true, component: stubComponent });

    registry.unregisterSessionView("tmux");

    expect(registry.sessionViews).toEqual([]);
    expect(registry.resolveSessionView({ session: session() })).toBeUndefined();
  });
});
