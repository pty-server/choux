// Reserved-chord key dispatch: intercepts a single global chord (Mod+K) so
// the command palette opens before xterm.js ever sees the event.
//
// Platform mapping:
// - macOS: physical Cmd+K (metaKey only, no ctrl/alt/shift) -> "Mod+K".
//   Cmd is never consumed by shell readline bindings, so this is safe.
// - Linux/Windows: physical Ctrl+Shift+K (ctrl+shift, no meta/alt) -> "Mod+K".
//   Plain Ctrl+K is deliberately NOT used because it collides with readline's
//   kill-line, a binding used constantly inside real shells. Ctrl+Shift+K is
//   not a common shell/terminal binding.
// - Any other key combo returns undefined (not reserved, passthrough untouched).

import type { KernelRegistry } from "../../registry/types";

export function isMacPlatform(
  nav: Pick<Navigator, "platform" | "userAgent"> | undefined =
    typeof navigator !== "undefined" ? navigator : undefined,
): boolean {
  if (!nav) return false;
  return (
    "Mac" === nav.platform.slice(0, 3) ||
    nav.userAgent.includes("Mac") ||
    nav.userAgent.includes("iPhone") ||
    nav.userAgent.includes("iPad")
  );
}

export function chordForEvent(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  isMac: boolean,
): string | undefined {
  const key = event.key.toLowerCase();

  if (isMac) {
    if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === "k") {
      return "Mod+K";
    }
  } else {
    if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && key === "k") {
      return "Mod+K";
    }
  }

  return undefined;
}

export type ReservedKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
  preventDefault(): void;
  stopPropagation(): void;
};

export function dispatchReservedKeydown(
  event: ReservedKeyEvent,
  registry: KernelRegistry,
  isMac?: boolean,
): boolean {
  const mac = isMac ?? isMacPlatform();
  const chord = chordForEvent(event, mac);

  if (chord === undefined) {
    return false;
  }

  const command = registry.resolveKeybinding(chord);

  if (command === undefined) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  command.run();

  return true;
}
