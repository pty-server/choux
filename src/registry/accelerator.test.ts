import { describe, expect, it } from "vitest";
import { acceleratorFromKeyboardEvent, describeAccelerator, isValidAccelerator } from "./accelerator";
import { defaultGlobalShortcutSettings } from "./globalShortcut";

function press(code: string, modifiers: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) {
  return acceleratorFromKeyboardEvent({
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  });
}

describe("accelerators", () => {
  it("accepts the default reveal shortcut", () => {
    expect(isValidAccelerator(defaultGlobalShortcutSettings.accelerator)).toBe(true);
  });

  it("rejects a bare key, a modifier-only chord, and Shift as the only modifier", () => {
    expect(isValidAccelerator("KeyK")).toBe(false);
    expect(isValidAccelerator("Control+Shift")).toBe(false);
    expect(isValidAccelerator("Shift+KeyK")).toBe(false);
  });

  it("builds an accelerator from a key press", () => {
    expect(press("Space", { ctrlKey: true, shiftKey: true })).toBe("Control+Shift+Space");
    expect(press("KeyK", { metaKey: true })).toBe("Super+KeyK");
  });

  it("returns nothing while only modifiers are held or the chord is unusable", () => {
    expect(press("ShiftLeft", { shiftKey: true })).toBeUndefined();
    expect(press("KeyK")).toBeUndefined();
  });

  it("describes an accelerator for display", () => {
    expect(describeAccelerator("CmdOrCtrl+Shift+Space")).toBe("Cmd/Ctrl + Shift + Space");
    expect(describeAccelerator("Control+Alt+KeyK")).toBe("Ctrl + Alt + K");
  });
});