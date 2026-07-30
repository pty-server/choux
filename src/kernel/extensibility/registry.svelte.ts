// The internal kernel registry (CLIENT.md section 2): features register
// commands, keybindings, and chrome slot items into this at runtime via
// Svelte context (`../registry/context.ts`) instead of the shell importing
// feature modules directly. Kept intentionally lean - commands, keybinding
// chords, and four chrome slot arrays (rail/sidebar/status/pane types) only.
// A pane-type plugin API and session decorators are explicitly deferred, not
// built here (CLIENT.md 13.2). The registry itself is private and freely
// breakable - no versioning or duplicate-registration guards.
//
// `.svelte.ts` (not `.ts`) so Svelte 5 rune syntax (`$state`) is compiled -
// the chrome slot arrays are reactive so shell chrome re-renders when a
// feature registers into them at runtime.
import { SvelteMap } from "svelte/reactivity";
import type { ChromeSlotItem, Command, KernelRegistry } from "../../registry/types";

function insertOrdered(items: ChromeSlotItem[], item: ChromeSlotItem): void {
  if (item.order === undefined) {
    items.push(item);
    return;
  }
  const index = items.findIndex((existing) => existing.order === undefined || existing.order > item.order!);
  if (index === -1) {
    items.push(item);
  } else {
    items.splice(index, 0, item);
  }
}

export function createKernelRegistry(): KernelRegistry {
  const commands = new SvelteMap<string, Command>();
  const keybindings = new SvelteMap<string, string>();

  const railItems = $state<ChromeSlotItem[]>([]);
  const sidebarItems = $state<ChromeSlotItem[]>([]);
  const statusItems = $state<ChromeSlotItem[]>([]);
  const paneTypes = $state<ChromeSlotItem[]>([]);

  return {
    registerCommand(command) {
      commands.set(command.id, command);
    },
    // Chords are left alone: `resolveKeybinding` already misses on a gone command.
    unregisterCommand(id) {
      commands.delete(id);
    },
    getCommand(id) {
      return commands.get(id);
    },
    listCommands() {
      return [...commands.values()];
    },

    registerKeybinding(chord, commandId) {
      keybindings.set(chord, commandId);
    },
    resolveKeybinding(chord) {
      const commandId = keybindings.get(chord);
      if (commandId === undefined) return undefined;
      return commands.get(commandId);
    },

    registerRailItem(item) {
      insertOrdered(railItems, item);
    },
    registerSidebarItem(item) {
      insertOrdered(sidebarItems, item);
    },
    registerStatusItem(item) {
      insertOrdered(statusItems, item);
    },
    registerPaneType(item) {
      insertOrdered(paneTypes, item);
    },

    get railItems() {
      return railItems;
    },
    get sidebarItems() {
      return sidebarItems;
    },
    get statusItems() {
      return statusItems;
    },
    get paneTypes() {
      return paneTypes;
    },
  };
}
