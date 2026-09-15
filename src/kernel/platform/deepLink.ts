export interface SessionDeepLink {
  serverId: string;
  sessionId: string;
}

export interface DeepLinkCandidate {
  readonly config: { readonly id: string; readonly serverId?: string };
  readonly status: string;
  readonly sessions: readonly { readonly id: string }[];
}

export function serverForDeepLink<T extends DeepLinkCandidate>(servers: readonly T[], link: SessionDeepLink): T | undefined {
  const sharing = servers.filter((server) => server.config.serverId === link.serverId);
  return sharing.find((server) => server.sessions.some((session) => session.id === link.sessionId))
    ?? sharing.find((server) => server.status === "online")
    ?? sharing[0]
    ?? servers.find((server) => server.config.id === link.serverId);
}

/** Parse the only supported public deep-link shape. */
export function parseSessionDeepLink(value: string): SessionDeepLink | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "choux:" || url.hostname !== "server" || url.search || url.hash) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[1] !== "session" || !parts[0] || !parts[2]) return undefined;
  try {
    return { serverId: decodeURIComponent(parts[0]), sessionId: decodeURIComponent(parts[2]) };
  } catch {
    return undefined;
  }
}

export async function listenForSessionDeepLinks(
  onLink: (link: SessionDeepLink) => void,
): Promise<() => void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};

  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const deliver = (urls: string[]) => {
    for (const url of urls) {
      const link = parseSessionDeepLink(url);
      if (link) onLink(link);
    }
  };

  const current = await getCurrent();
  if (current) deliver(current);
  return onOpenUrl((urls) => deliver(urls));
}
