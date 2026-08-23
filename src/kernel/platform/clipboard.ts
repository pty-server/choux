// WebKitGTK does not implement `navigator.clipboard.readText`, so the desktop
// build goes through the Tauri clipboard plugin and only the browser build
// falls back to the async clipboard API.
import { isTauriRuntime } from "../storage/tokenStore";

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauriRuntime()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function readClipboardText(): Promise<string> {
  if (isTauriRuntime()) {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return await readText();
  }
  return await navigator.clipboard.readText();
}
