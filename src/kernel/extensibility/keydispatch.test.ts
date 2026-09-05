import { describe, expect, it, vi, type Mock } from "vitest";
import { createKernelRegistry } from "./registry.svelte";
import { dispatchReservedKeydown, isMacPlatform, isTextEntryTarget, type ReservedKeyEvent } from "./keydispatch";
import { keybindingsByAccelerator, resolveKeybindings } from "../../registry/keybindings";
import { beginKeyCapture } from "../../registry/keyCapture";

function makeMockEvent(
  overrides: Partial<Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {},
): ReservedKeyEvent & { preventDefault: Mock<() => void>; stopPropagation: Mock<() => void> } {
  return {
    code: "KeyA",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
    preventDefault: vi.fn<() => void>(),
    stopPropagation: vi.fn<() => void>(),
  };
}

function elementLike(
  tagName: string,
  { contentEditable = false, insideTerminal = false }: { contentEditable?: boolean; insideTerminal?: boolean } = {},
) {
  return {
    tagName,
    isContentEditable: contentEditable,
    closest: (selector: string) => (selector === ".xterm" && insideTerminal ? {} : null),
  };
}

function registryWith(commandId: string, run: () => void) {
  const registry = createKernelRegistry();
  registry.registerCommand({ id: commandId, title: commandId, run });
  return registry;
}

describe("dispatchReservedKeydown", () => {
  it("runs the bound command and stops the event reaching the pty", () => {
    const run = vi.fn();
    const registry = registryWith("test.cmd", run);
    const event = makeMockEvent({ code: "KeyK", ctrlKey: true, shiftKey: true });

    const result = dispatchReservedKeydown(event, registry, { "Control+Shift+KeyK": "test.cmd" });

    expect(result).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("leaves an unbound chord alone (passthrough-to-pty proof)", () => {
    const run = vi.fn();
    const registry = registryWith("test.cmd", run);
    const event = makeMockEvent({ code: "KeyK", ctrlKey: true });

    const result = dispatchReservedKeydown(event, registry, { "Control+Shift+KeyK": "test.cmd" });

    expect(result).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("does not fire when an extra modifier is held", () => {
    const run = vi.fn();
    const registry = registryWith("test.cmd", run);

    const result = dispatchReservedKeydown(
      makeMockEvent({ code: "KeyK", ctrlKey: true, shiftKey: true, altKey: true }),
      registry,
      { "Control+Shift+KeyK": "test.cmd" },
    );

    expect(result).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("still honours a chord a feature registered straight through the registry", () => {
    const run = vi.fn();
    const registry = registryWith("test.cmd", run);
    registry.registerKeybinding("Control+Alt+KeyJ", "test.cmd");

    const result = dispatchReservedKeydown(
      makeMockEvent({ code: "KeyJ", ctrlKey: true, altKey: true }),
      registry,
      {},
    );

    expect(result).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores a chord whose command was never registered", () => {
    const registry = createKernelRegistry();

    const result = dispatchReservedKeydown(
      makeMockEvent({ code: "KeyK", ctrlKey: true, shiftKey: true }),
      registry,
      { "Control+Shift+KeyK": "missing.cmd" },
    );

    expect(result).toBe(false);
  });

  it("opens the palette on the platform default chord", () => {
    for (const [isMac, event] of [
      [true, makeMockEvent({ code: "KeyK", metaKey: true })],
      [false, makeMockEvent({ code: "KeyK", ctrlKey: true, shiftKey: true })],
    ] as const) {
      const run = vi.fn();
      const registry = registryWith("palette.open", run);
      const keybindings = keybindingsByAccelerator(resolveKeybindings({}, isMac));

      expect(dispatchReservedKeydown(event, registry, keybindings)).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("stands down while a settings field is recording a chord", () => {
    const run = vi.fn();
    const registry = registryWith("test.cmd", run);
    const event = makeMockEvent({ code: "KeyK", ctrlKey: true, shiftKey: true });
    const release = beginKeyCapture();

    expect(dispatchReservedKeydown(event, registry, { "Control+Shift+KeyK": "test.cmd" })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();

    release();

    expect(dispatchReservedKeydown(event, registry, { "Control+Shift+KeyK": "test.cmd" })).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves a chord alone while a text field outside the terminal has focus", () => {
    const run = vi.fn();
    const registry = registryWith("terminal.paste", run);
    const event = { ...makeMockEvent({ code: "KeyV", metaKey: true }), target: elementLike("INPUT") };

    expect(dispatchReservedKeydown(event, registry, { "Super+KeyV": "terminal.paste" })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("still fires for the helper textarea xterm keeps focused", () => {
    const run = vi.fn();
    const registry = registryWith("terminal.paste", run);
    const event = {
      ...makeMockEvent({ code: "KeyV", metaKey: true }),
      target: elementLike("TEXTAREA", { insideTerminal: true }),
    };

    expect(dispatchReservedKeydown(event, registry, { "Super+KeyV": "terminal.paste" })).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves plain Ctrl+K to readline's kill-line by default", () => {
    const run = vi.fn();
    const registry = registryWith("palette.open", run);
    const keybindings = keybindingsByAccelerator(resolveKeybindings({}, false));

    expect(dispatchReservedKeydown(makeMockEvent({ code: "KeyK", ctrlKey: true }), registry, keybindings)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("isTextEntryTarget", () => {
  it("covers inputs, textareas, selects and contenteditable hosts", () => {
    expect(isTextEntryTarget(elementLike("INPUT"))).toBe(true);
    expect(isTextEntryTarget(elementLike("TEXTAREA"))).toBe(true);
    expect(isTextEntryTarget(elementLike("SELECT"))).toBe(true);
    expect(isTextEntryTarget(elementLike("DIV", { contentEditable: true }))).toBe(true);
  });

  it("ignores non-editable targets and anything inside the terminal", () => {
    expect(isTextEntryTarget(elementLike("DIV"))).toBe(false);
    expect(isTextEntryTarget(elementLike("BUTTON"))).toBe(false);
    expect(isTextEntryTarget(elementLike("INPUT", { insideTerminal: true }))).toBe(false);
    expect(isTextEntryTarget(undefined)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

describe("isMacPlatform", () => {
  it("returns true for Mac platform strings", () => {
    expect(isMacPlatform({ platform: "MacIntel", userAgent: "" })).toBe(true);
    expect(isMacPlatform({ platform: "Mac68K", userAgent: "" })).toBe(true);
  });

  it("returns true when userAgent contains Mac", () => {
    expect(isMacPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Macintosh; Intel)" })).toBe(true);
  });

  it("returns true for iPhone/iPad user agents", () => {
    expect(isMacPlatform({ platform: "CPU iPhone", userAgent: "iPhone1" })).toBe(true);
    expect(isMacPlatform({ platform: "CPU iPad", userAgent: "iPad1" })).toBe(true);
  });

  it("returns false when navigator is undefined", () => {
    expect(isMacPlatform(undefined)).toBe(false);
  });

  it("returns false for non-Mac platforms", () => {
    expect(isMacPlatform({ platform: "Win32", userAgent: "" })).toBe(false);
    expect(isMacPlatform({ platform: "Linux x86_64", userAgent: "" })).toBe(false);
  });
});
