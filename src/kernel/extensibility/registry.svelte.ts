// The internal kernel registry (CLIENT.md section 2): features register
// commands, keybindings, and chrome slot items into this at runtime via
// Svelte context (`../registry/context.ts`) instead of the shell importing
// feature modules directly. Kept intentionally lean - commands, keybinding
// chords, four chrome slot arrays (rail/sidebar/status/pane types), and
// session views. A pane-type plugin API is still deferred (CLIENT.md 13.2).
// The registry itself is private and freely breakable - no versioning or
// duplicate-registration guards.
//
// `.svelte.ts` (not `.ts`) so Svelte 5 rune syntax (`$state`) is compiled -
// the chrome slot arrays are reactive so shell chrome re-renders when a
// feature registers into them at runtime.
import { SvelteMap } from "svelte/reactivity";
import type { ChromeSlotItem, Command, KernelRegistry, SessionViewItem } from "../../registry/types";

function insertOrdered<T extends { order?: number }>(items: T[], item: T): void {
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
  const sessionViews = $state<SessionViewItem[]>([]);

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

    registerSessionView(item) {
      insertOrdered(sessionViews, item);
    },
    unregisterSessionView(id) {
      const index = sessionViews.findIndex((existing) => existing.id === id);
      if (index !== -1) sessionViews.splice(index, 1);
    },
    resolveSessionView(context) {
      return sessionViews.find((view) => view.detect(context));
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
    get sessionViews() {
      return sessionViews;
    },
  };
}
