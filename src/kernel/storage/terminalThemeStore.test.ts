import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIndexedDB } from "./setup";
import { resetDbMemo } from "./db";
import { getTerminalSettings, saveTerminalSettings } from "./terminalThemeStore";
import { defaultTerminalSettings } from "../../registry/terminalTheme";

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

beforeEach(resetState);
afterEach(resetState);

describe("terminal theme settings", () => {
  it("uses the default theme until a theme is saved", async () => {
    expect(await getTerminalSettings()).toEqual(defaultTerminalSettings);
  });

  it("persists terminal colors and font size", async () => {
    const settings = {
      ...defaultTerminalSettings,
      theme: { ...defaultTerminalSettings.theme, background: "#123456", brightMagenta: "#abcdef" },
      fontSize: 18,
    };
    await saveTerminalSettings(settings);
    resetDbMemo();

    expect(await getTerminalSettings()).toEqual(settings);
  });
});
