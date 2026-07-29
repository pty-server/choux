import { metaStoreName, openDatabase, randomId, serversStoreName } from "./db";
import { tokenStore } from "./tokenStore";

export { tokenStore };

export interface ServerConfig {
  id: string;
  label: string;
  accent: string;
  url: string;
  /** Local ptys daemons use their private Unix control socket, not this URL. */
  transport?: "local";
  /** Ptys instance name for transport:local records. */
  instance?: string;
  /** Stable server identity from /v1/info; backfilled after the first poll. */
  serverId?: string;
  /** Missing on older records and therefore treated as token authentication. */
  auth?: "token" | "none";
  /** Keychain/IndexedDB reference. No value is stored for auth:none records. */
  tokenRef: string;
}

export interface SavedSettings {
  baseUrl: string;
  token: string;
}

export const accentPalette: string[] = [
  "#4C6EF5",
  "#12B886",
  "#F76707",
  "#E64980",
  "#7048E8",
  "#1098AD",
  "#F59F00",
  "#495057",
];

export function serverUsesToken(config: ServerConfig): boolean {
  return config.transport !== "local" && config.auth !== "none";
}

function normalizeServer(config: ServerConfig): ServerConfig {
  return { ...config, auth: config.transport === "local" ? "none" : config.auth ?? "token" };
}

const defaultServerKey = "defaultServerId";

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function listServers(): Promise<ServerConfig[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(serversStoreName).objectStore(serversStoreName).getAll();
    request.onsuccess = () => resolve((request.result as ServerConfig[]).map(normalizeServer));
    request.onerror = () => reject(request.error);
  });
}

export async function getDefaultServerId(): Promise<string | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(metaStoreName).objectStore(metaStoreName).get(defaultServerKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function setDefaultServerId(id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(id, defaultServerKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getServer(id: string): Promise<ServerConfig | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(serversStoreName).objectStore(serversStoreName).get(id);
    request.onsuccess = () => resolve(request.result === undefined ? undefined : normalizeServer(request.result as ServerConfig));
    request.onerror = () => reject(request.error);
  });
}

export async function putServer(config: ServerConfig): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(serversStoreName, "readwrite").objectStore(serversStoreName).put(config);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function deleteServer(id: string): Promise<void> {
  const db = await openDatabase();
  const existing = await getServer(id);
  if (!existing) return;
  await tokenStore.delete(existing.tokenRef);
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(serversStoreName, "readwrite").objectStore(serversStoreName).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function addServer(input: {
  url: string;
  transport?: "local";
  instance?: string;
  label?: string;
  token?: string;
  accent?: string;
  auth?: "token" | "none";
  serverId?: string;
}): Promise<ServerConfig> {
  if (input.transport === "local" && !input.instance) throw new Error("A local ptys instance is required.");
  const auth = input.transport === "local" ? "none" : input.auth ?? "token";
  if (auth === "token" && !input.token) throw new Error("A server token is required.");
  const currentServerCount = (await listServers()).length;
  const id = randomId();
  const accent = input.accent ?? accentPalette[currentServerCount % accentPalette.length];
  const label = input.label ?? hostFromUrl(input.url);
  const tokenRef = id;

  if (auth === "token" && input.token) await tokenStore.set(tokenRef, input.token);
  const config: ServerConfig = {
    id, label, accent, url: input.url, serverId: input.serverId, auth, tokenRef,
    ...(input.transport === "local" ? { transport: "local" as const, instance: input.instance } : {}),
  };
  await putServer(config);
  return config;
}

export async function updateServer(
  id: string,
  patch: { label?: string; accent?: string; url?: string; token?: string; serverId?: string },
): Promise<ServerConfig | undefined> {
  const existing = await getServer(id);
  if (!existing) return undefined;
  const updated: ServerConfig = {
    ...existing,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.accent !== undefined ? { accent: patch.accent } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.serverId !== undefined ? { serverId: patch.serverId } : {}),
  };
  await putServer(updated);
  if (patch.token) {
    await tokenStore.set(existing.tokenRef, patch.token);
  }
  return updated;
}

export async function getActiveServer(): Promise<SavedSettings | undefined> {
  const servers = await listServers();
  if (!servers.length) return undefined;
  const server = servers[0];
  if (!serverUsesToken(server)) return { baseUrl: server.url, token: "" };
  const token = await tokenStore.get(server.tokenRef);
  if (!token) return undefined;
  return { baseUrl: server.url, token };
}

export async function saveActiveServer(settings: SavedSettings): Promise<ServerConfig> {
  const servers = await listServers();
  if (servers.length > 0) {
    const existing = servers[0];
    await tokenStore.set(existing.tokenRef, settings.token);
    const updated: ServerConfig = {
      ...existing,
      url: settings.baseUrl,
      label: hostFromUrl(settings.baseUrl),
    };
    await putServer(updated);
    return updated;
  }
  return addServer({ url: settings.baseUrl, token: settings.token });
}
