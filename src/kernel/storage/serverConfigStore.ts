import { metaStoreName, openDatabase, randomId, serversStoreName } from "./db";
import { tokenStore } from "./tokenStore";
import { defaultServerLabel, nativeServerUrl, transportProblem, type ServerTransport } from "../../registry/serverTransport";

export { tokenStore };

export interface ServerConfig {
  id: string;
  label: string;
  accent: string;
  url: string;
  transport?: ServerTransport;
  /** Stable server identity from /v1/info; backfilled after the first poll. */
  serverId?: string;
  /** Missing on older records and therefore treated as token authentication. */
  auth?: "token" | "none";
  /** Keychain/IndexedDB reference. No value is stored for auth:none records. */
  tokenRef: string;
}

export interface ServerInput {
  url: string;
  transport?: ServerTransport;
  label?: string;
  token?: string;
  accent?: string;
  auth?: "token" | "none";
  serverId?: string;
}

export interface ServerPatch {
  label?: string;
  accent?: string;
  url?: string;
  transport?: ServerTransport;
  token?: string;
  serverId?: string;
}

type StoredServer = Omit<ServerConfig, "transport"> & {
  transport?: ServerTransport | "local";
  instance?: string;
};

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
  return config.transport === undefined && config.auth !== "none";
}

function normalizeServer(record: StoredServer): ServerConfig {
  const { transport, instance, ...config } = record;
  if (transport === undefined) return { ...config, auth: config.auth ?? "token" };
  const normalized = transport === "local" ? { kind: "local", instance } as ServerTransport : transport;
  return { ...config, transport: normalized, auth: "none" };
}

function assertValidTransport(transport: ServerTransport): void {
  const problem = transportProblem(transport);
  if (problem !== undefined) throw new Error(problem);
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
    request.onsuccess = () => resolve((request.result as StoredServer[]).map(normalizeServer));
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
    request.onsuccess = () => resolve(request.result === undefined ? undefined : normalizeServer(request.result as StoredServer));
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

export async function addServer(input: ServerInput): Promise<ServerConfig> {
  const transport = input.transport === undefined ? undefined : { ...input.transport };
  if (transport !== undefined) assertValidTransport(transport);
  const auth = transport === undefined ? input.auth ?? "token" : "none";
  if (auth === "token" && !input.token) throw new Error("A server token is required.");
  const currentServerCount = (await listServers()).length;
  const id = randomId();
  const accent = input.accent ?? accentPalette[currentServerCount % accentPalette.length];
  const label = input.label ?? (transport === undefined ? hostFromUrl(input.url) : defaultServerLabel(transport));
  const tokenRef = id;

  if (auth === "token" && input.token) await tokenStore.set(tokenRef, input.token);
  const config: ServerConfig = {
    id,
    label,
    accent,
    url: transport === undefined ? input.url : nativeServerUrl(transport),
    serverId: input.serverId,
    auth,
    tokenRef,
    ...(transport === undefined ? {} : { transport }),
  };
  await putServer(config);
  return config;
}

export async function updateServer(id: string, patch: ServerPatch): Promise<ServerConfig | undefined> {
  const existing = await getServer(id);
  if (!existing) return undefined;
  const transport = patch.transport === undefined ? undefined : { ...patch.transport };
  if (transport !== undefined) {
    if (existing.transport === undefined) throw new Error("A server reached by URL cannot switch to a native connection.");
    assertValidTransport(transport);
  }
  const updated: ServerConfig = {
    ...existing,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.accent !== undefined ? { accent: patch.accent } : {}),
    ...(patch.url !== undefined && existing.transport === undefined ? { url: patch.url } : {}),
    ...(transport !== undefined ? { transport, url: nativeServerUrl(transport) } : {}),
    ...(patch.serverId !== undefined ? { serverId: patch.serverId } : {}),
  };
  await putServer(updated);
  if (patch.token && existing.transport === undefined) {
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
