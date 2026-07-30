import { describe, expect, it } from "vitest";
import { createKernelRegistry } from "./registry.svelte";

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
});
