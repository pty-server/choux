import { isTauriRuntime } from "../storage/tokenStore";

export function openExternalUrl(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (isTauriRuntime()) {
    void import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(url))
      .catch(() => {});
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}
