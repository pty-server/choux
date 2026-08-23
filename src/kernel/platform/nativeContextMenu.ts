// The webview's own menu offers Delete / Insert Emoji / Inspect Element over a
// terminal, and opens on top of whatever menu the pty application drew. The
// desktop build hides it everywhere and puts Choux's menus in its place; the
// browser build keeps it outside the terminal, where users expect it.
import { isTauriRuntime } from "../storage/tokenStore";

export function suppressNativeContextMenu(target: EventTarget = window): () => void {
  if (!isTauriRuntime()) return () => {};

  const handler = (event: Event) => event.preventDefault();
  target.addEventListener("contextmenu", handler);
  return () => target.removeEventListener("contextmenu", handler);
}
