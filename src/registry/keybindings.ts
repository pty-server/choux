import { isValidAccelerator } from "./accelerator";

export interface BindableCommand {
  commandId: string;
  title: string;
  defaultAccelerator?: (isMac: boolean) => string;
}

// Plain Ctrl+K is readline's kill-line, so the non-mac default takes Shift too.
export const bindableCommands: readonly BindableCommand[] = [
  {
    commandId: "palette.open",
    title: "Open command palette",
    defaultAccelerator: (isMac) => (isMac ? "Super+KeyK" : "Control+Shift+KeyK"),
  },
  { commandId: "session.new", title: "New session" },
  { commandId: "workspace.add", title: "Add workspace" },
  { commandId: "settings.open", title: "Open settings" },
  { commandId: "sidebar.toggle", title: "Toggle sidebar" },
  { commandId: "rail.toggle", title: "Toggle rail" },
];

/** `null` unbinds; an absent entry falls back to the built-in default. */
export type KeybindingOverrides = Readonly<Record<string, string | null>>;

/** commandId -> accelerator */
export type ResolvedKeybindings = Readonly<Record<string, string>>;

export function resolveKeybindings(overrides: KeybindingOverrides, isMac: boolean): ResolvedKeybindings {
  const resolved: Record<string, string> = {};
  for (const command of bindableCommands) {
    const override = overrides[command.commandId];
    if (override === null) continue;
    const accelerator = override ?? command.defaultAccelerator?.(isMac);
    if (accelerator !== undefined && isValidAccelerator(accelerator)) {
      resolved[command.commandId] = accelerator;
    }
  }
  return resolved;
}

/** accelerator -> commandId */
export function keybindingsByAccelerator(resolved: ResolvedKeybindings): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(resolved).map(([commandId, accelerator]) => [accelerator, commandId]));
}

export function conflictingCommandIds(resolved: ResolvedKeybindings): string[] {
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
  for (const command of bindableCommands) {
    const accelerator = resolved[command.commandId];
    if (accelerator === undefined) continue;
    if (seen.has(accelerator)) conflicts.push(command.commandId);
    else seen.set(accelerator, command.commandId);
  }
  return conflicts;
}
