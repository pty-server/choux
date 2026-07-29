import { describe, expect, it } from "vitest";
import {
  bindableCommands,
  conflictingCommandIds,
  keybindingsByAccelerator,
  resolveKeybindings,
} from "./keybindings";

describe("keybindings", () => {
  it("binds only the palette out of the box, per platform", () => {
    expect(resolveKeybindings({}, false)).toEqual({ "palette.open": "Control+Shift+KeyK" });
    expect(resolveKeybindings({}, true)).toEqual({ "palette.open": "Super+KeyK" });
  });

  it("applies an override and drops a deliberately unbound command", () => {
    expect(resolveKeybindings({ "palette.open": null, "session.new": "Control+Alt+KeyN" }, false)).toEqual({
      "session.new": "Control+Alt+KeyN",
    });
  });

  it("ignores an override that is not a usable chord", () => {
    expect(resolveKeybindings({ "palette.open": "Shift+KeyK" }, false)).toEqual({});
  });

  it("ignores an override for a command that is not bindable", () => {
    expect(resolveKeybindings({ "nope.cmd": "Control+Alt+KeyN" }, false)).toEqual({
      "palette.open": "Control+Shift+KeyK",
    });
  });

  it("inverts the table for key dispatch", () => {
    expect(keybindingsByAccelerator({ "palette.open": "Control+Shift+KeyK" })).toEqual({
      "Control+Shift+KeyK": "palette.open",
    });
  });

  it("reports the later command when two share a chord", () => {
    const resolved = resolveKeybindings(
      { "palette.open": "Control+Alt+KeyN", "session.new": "Control+Alt+KeyN" },
      false,
    );

    expect(conflictingCommandIds(resolved)).toEqual(["session.new"]);
    expect(conflictingCommandIds(resolveKeybindings({}, false))).toEqual([]);
  });

  it("lists every command the shell and palette register", () => {
    expect(bindableCommands.map((command) => command.commandId)).toEqual([
      "palette.open",
      "session.new",
      "workspace.add",
      "settings.open",
      "sidebar.toggle",
      "rail.toggle",
    ]);
  });
});
