import { describe, expect, it, vi, type Mock } from "vitest";
import { createKernelRegistry } from "./registry.svelte";
import { chordForEvent, dispatchReservedKeydown, isMacPlatform, type ReservedKeyEvent } from "./keydispatch";

function fakeEvent(
  overrides: Partial<Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {},
): Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> {
  return { key: "a", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides };
}

describe("chordForEvent", () => {
  it("mac Cmd+K -> 'Mod+K'", () => {
    expect(chordForEvent({ key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe("Mod+K");
  });

  it("mac Ctrl+K alone -> undefined (must NOT match, proves it does not clobber the mac Ctrl+K-adjacent path)", () => {
    expect(chordForEvent(fakeEvent({ key: "k", ctrlKey: true }), true)).toBeUndefined();
  });

  it("non-mac Ctrl+Shift+K -> 'Mod+K'", () => {
    expect(chordForEvent(fakeEvent({ key: "k", ctrlKey: true, shiftKey: true }), false)).toBe("Mod+K");
  });

  it("non-mac plain Ctrl+K -> undefined (preserves readline kill-line passthrough)", () => {
    expect(chordForEvent(fakeEvent({ key: "k", ctrlKey: true }), false)).toBeUndefined();
  });

  it("unrelated key like plain 'a' -> undefined", () => {
    expect(chordForEvent(fakeEvent({ key: "a" }), false)).toBeUndefined();
  });

  it("case-insensitive: 'K' also matches", () => {
    expect(chordForEvent({ key: "K", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe("Mod+K");
    expect(chordForEvent({ key: "K", ctrlKey: true, shiftKey: true, metaKey: false, altKey: false }, false)).toBe("Mod+K");
  });
});

describe("dispatchReservedKeydown", () => {
  function makeMockEvent(
    overrides: Partial<Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {},
  ): ReservedKeyEvent & { preventDefault: Mock<() => void>; stopPropagation: Mock<() => void> } {
    const base = fakeEvent(overrides);
    return {
      ...base,
      preventDefault: vi.fn<() => void>(),
      stopPropagation: vi.fn<() => void>(),
    };
  }

  it("reserved chord calls preventDefault, stopPropagation, and command.run", () => {
    const registry = createKernelRegistry();
    const runSpy = vi.fn();
    registry.registerCommand({ id: "test.cmd", title: "Test", run: runSpy });
    registry.registerKeybinding("Mod+K", "test.cmd");

    const event = makeMockEvent({ key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });

    const result = dispatchReservedKeydown(event as unknown as KeyboardEvent, registry, true);

    expect(result).toBe(true);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("non-reserved key returns false, does NOT call run/preventDefault/stopPropagation (passthrough-to-pty proof)", () => {
    const registry = createKernelRegistry();
    const runSpy = vi.fn();
    registry.registerCommand({ id: "test.cmd", title: "Test", run: runSpy });
    registry.registerKeybinding("Mod+K", "test.cmd");

    const event = makeMockEvent({ key: "k" });

    const result = dispatchReservedKeydown(event as unknown as KeyboardEvent, registry);

    expect(result).toBe(false);
    expect(runSpy).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
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
