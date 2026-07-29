import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIndexedDB } from "./setup";
import { resetDbMemo } from "./db";
import { getGlobalShortcutSettings, saveGlobalShortcutSettings } from "./globalShortcutStore";
import { defaultGlobalShortcutSettings } from "../../registry/globalShortcut";

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

beforeEach(resetState);
afterEach(resetState);

describe("global shortcut settings", () => {
  it("stays disabled until a shortcut is saved", async () => {
    expect(await getGlobalShortcutSettings()).toEqual(defaultGlobalShortcutSettings);
  });

  it("persists the enabled state and accelerator", async () => {
    const settings = { enabled: true, accelerator: "Control+Alt+KeyK" };
    await saveGlobalShortcutSettings(settings);
    resetDbMemo();

    expect(await getGlobalShortcutSettings()).toEqual(settings);
  });

  it("falls back to the default accelerator when the stored one is unusable", async () => {
    await saveGlobalShortcutSettings({ enabled: true, accelerator: "Shift+KeyK" });
    resetDbMemo();

    expect(await getGlobalShortcutSettings()).toEqual({
      enabled: true,
      accelerator: defaultGlobalShortcutSettings.accelerator,
    });
  });
});