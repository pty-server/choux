import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIndexedDB } from "./setup";
import { resetDbMemo } from "./db";
import { getKeybindingOverrides, saveKeybindingOverrides } from "./keybindingStore";

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

beforeEach(resetState);
afterEach(resetState);

describe("keybinding overrides", () => {
  it("starts with no overrides", async () => {
    expect(await getKeybindingOverrides()).toEqual({});
  });

  it("persists a rebound and an unbound command", async () => {
    await saveKeybindingOverrides({ "session.new": "Control+Alt+KeyN", "palette.open": null });
    resetDbMemo();

    expect(await getKeybindingOverrides()).toEqual({ "palette.open": null, "session.new": "Control+Alt+KeyN" });
  });

  it("drops unusable chords and unknown commands", async () => {
    await saveKeybindingOverrides({ "session.new": "Shift+KeyN", "nope.cmd": "Control+Alt+KeyN" });
    resetDbMemo();

    expect(await getKeybindingOverrides()).toEqual({});
  });
});
