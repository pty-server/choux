// Intercepts the configured chords so a command runs before xterm.js sees the
// event; every other key passes through to the pty untouched.
import { acceleratorFromKeyboardEvent } from "../../registry/accelerator";
import { keyCaptureActive } from "../../registry/keyCapture";
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

export type ReservedKeyEvent = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
  target?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
};

const textEntryTags = new Set(["INPUT", "TEXTAREA", "SELECT"]);

interface ElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  closest?: (selector: string) => unknown;
}

export function isTextEntryTarget(target: unknown): boolean {
  const element = target as ElementLike | null | undefined;
  if (!element || typeof element.closest !== "function") {
    return false;
  }
  if (element.closest(".xterm") != null) {
    return false;
  }
  if (element.isContentEditable === true) {
    return true;
  }
  return typeof element.tagName === "string" && textEntryTags.has(element.tagName);
}

export function dispatchReservedKeydown(
  event: ReservedKeyEvent,
  registry: KernelRegistry,
  keybindings: Readonly<Record<string, string>>,
): boolean {
  if (keyCaptureActive() || isTextEntryTarget(event.target)) {
    return false;
  }

  const accelerator = acceleratorFromKeyboardEvent(event);

  if (accelerator === undefined) {
    return false;
  }

  const commandId = keybindings[accelerator];
  const command = commandId === undefined
    ? registry.resolveKeybinding(accelerator)
    : registry.getCommand(commandId);

  if (command === undefined) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  command.run();

  return true;
}