export async function revealAndFocusCurrentWindow(): Promise<void> {
  // The browser build deliberately has no native window to reveal.
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    await appWindow.show();
    await appWindow.unminimize();
    await appWindow.requestUserAttention(UserAttentionType.Informational);
    await appWindow.setFocus();
  } catch {
    // A desktop environment can refuse an unsolicited focus request. The
    // question remains queued and visible whenever the user opens Choux.
  }
}
