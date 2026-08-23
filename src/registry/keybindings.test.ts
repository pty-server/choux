import { describe, expect, it } from "vitest";
import {
  bindableCommands,
  conflictingCommandIds,
  keybindingsByAccelerator,
  resolveKeybindings,
} from "./keybindings";

describe("keybindings", () => {
  it("binds the palette and the clipboard out of the box, per platform", () => {
    expect(resolveKeybindings({}, false)).toEqual({
      "palette.open": "Control+Shift+KeyK",
      "terminal.copy": "Control+Shift+KeyC",
      "terminal.paste": "Control+Shift+KeyV",
    });
    expect(resolveKeybindings({}, true)).toEqual({
      "palette.open": "Super+KeyK",
      "terminal.copy": "Super+KeyC",
      "terminal.paste": "Super+KeyV",
    });
  });

  it("applies an override and drops a deliberately unbound command", () => {
    const overrides = {
      "palette.open": null,
      "session.new": "Control+Alt+KeyN",
      "terminal.copy": null,
      "terminal.paste": null,
    };

    expect(resolveKeybindings(overrides, false)).toEqual({ "session.new": "Control+Alt+KeyN" });
  });

  it("ignores an override that is not a usable chord", () => {
    expect(resolveKeybindings({ "palette.open": "Shift+KeyK", "terminal.copy": null, "terminal.paste": null }, false))
      .toEqual({});
  });

  it("ignores an override for a command that is not bindable", () => {
    expect(resolveKeybindings({ "nope.cmd": "Control+Alt+KeyN", "terminal.copy": null, "terminal.paste": null }, false))
      .toEqual({
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
      "terminal.copy",
      "terminal.paste",
      "terminal.selectAll",
      "session.new",
      "workspace.add",
      "settings.open",
      "sidebar.toggle",
      "rail.toggle",
    ]);
  });
});
