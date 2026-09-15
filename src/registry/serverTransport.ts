export type ServerTransport =
  | { readonly kind: "local"; readonly instance: string }
  | { readonly kind: "ssh"; readonly host: string; readonly instance: string; readonly nodeBin?: string }
  | { readonly kind: "wsl"; readonly distro: string; readonly user: string; readonly instance: string; readonly nodeBin?: string };

export interface ServerAddress {
  readonly url: string;
  readonly transport?: ServerTransport;
}

export const DEFAULT_INSTANCE = "default";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
const HOST_ADDRESS_PATTERN = /^[A-Za-z0-9:][A-Za-z0-9._:-]*$/;
const NODE_BIN_PATTERN = /^\/[A-Za-z0-9._/+@-]*$/;
const HOST_MAX = 255;
const NODE_BIN_MAX = 512;

export function instanceProblem(instance: unknown): string | undefined {
  return typeof instance === "string" && NAME_PATTERN.test(instance)
    ? undefined
    : "An instance name starts with a letter or digit and uses only letters, digits, '.', '_' and '-' (64 at most).";
}

export function sshHostProblem(host: unknown): string | undefined {
  if (typeof host === "string" && host.length <= HOST_MAX) {
    const at = host.indexOf("@");
    const user = at === -1 ? undefined : host.slice(0, at);
    const address = at === -1 ? host : host.slice(at + 1);
    if ((user === undefined || USER_PATTERN.test(user)) && HOST_ADDRESS_PATTERN.test(address)) return undefined;
  }
  return "An SSH host is a host name, address or ssh config alias, optionally with user@ in front.";
}

function hasPlainSegments(path: string): boolean {
  const segments = path.split("/").slice(1);
  return segments.every((segment, index) => (
    segment !== "." && segment !== ".." && (segment !== "" || index === segments.length - 1)
  ));
}

export function nodeBinProblem(nodeBin: unknown): string | undefined {
  if (nodeBin === undefined) return undefined;
  const valid = typeof nodeBin === "string"
    && nodeBin.length <= NODE_BIN_MAX
    && NODE_BIN_PATTERN.test(nodeBin)
    && hasPlainSegments(nodeBin);
  return valid ? undefined : "The node directory must be a plain absolute path of letters, digits and . _ - / + @, without . or .. segments or //.";
}

function wslProblem(value: Record<string, unknown>): string | undefined {
  if (typeof value.distro !== "string" || !NAME_PATTERN.test(value.distro)) return "Invalid WSL distribution name.";
  if (typeof value.user !== "string" || !USER_PATTERN.test(value.user)) return "Invalid WSL user name.";
  const nodeBin = value.nodeBin;
  if (nodeBin === "/mnt" || (typeof nodeBin === "string" && nodeBin.startsWith("/mnt/"))) {
    return "The node directory is on a Windows drive; use a Node.js installed inside the distribution.";
  }
  return instanceProblem(value.instance) ?? nodeBinProblem(nodeBin);
}

export function transportKind(transport: unknown): string | undefined {
  if (typeof transport !== "object" || transport === null) return undefined;
  const kind = (transport as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

export function validTransport(transport: unknown): ServerTransport | undefined {
  return transportProblem(transport) === undefined ? transport as ServerTransport : undefined;
}

export function transportProblem(transport: unknown): string | undefined {
  if (typeof transport !== "object" || transport === null) return "Unknown connection type.";
  const value = transport as Record<string, unknown>;
  switch (value.kind) {
    case "local":
      return instanceProblem(value.instance);
    case "ssh":
      return sshHostProblem(value.host) ?? instanceProblem(value.instance) ?? nodeBinProblem(value.nodeBin);
    case "wsl":
      return wslProblem(value);
    default:
      return "Unknown connection type.";
  }
}

export function serverAddressProblem(server: { url: string; transport?: unknown }): string | undefined {
  if (server.transport !== undefined) return transportProblem(server.transport);
  try {
    const { protocol } = new URL(server.url);
    if (protocol === "http:" || protocol === "https:") return undefined;
  } catch {
    return "The server URL is not a valid URL.";
  }
  return "The server URL must start with http:// or https://.";
}

export function normalizedServerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function connectionIdentity(server: ServerAddress): string {
  const transport = server.transport;
  switch (transport?.kind) {
    case "local":
      return `local:${transport.instance}`;
    case "ssh":
      return `ssh:${transport.host}:${transport.instance}`;
    case "wsl":
      return `wsl:${transport.distro}:${transport.user}:${transport.instance}`;
    default:
      return `url:${normalizedServerUrl(server.url)}`;
  }
}

function transportKey(transport: unknown): string {
  if (transport === undefined) return "none";
  if (typeof transport !== "object" || transport === null) return JSON.stringify(transport);
  return JSON.stringify(transport, Object.keys(transport).sort());
}

export function sameTransport(a: unknown, b: unknown): boolean {
  return transportKey(a) === transportKey(b);
}

export function serverAddressKey(server: { url: string; transport?: unknown }): string {
  return server.transport === undefined ? connectionIdentity({ url: server.url }) : transportKey(server.transport);
}

export function nativeServerUrl(transport: ServerTransport): string {
  return `http://${transport.instance}.ptys.local`;
}

export function defaultServerLabel(transport: ServerTransport): string {
  const suffix = transport.instance === DEFAULT_INSTANCE ? "" : ` ${transport.instance}`;
  switch (transport.kind) {
    case "local":
      return `Local ${transport.instance}`;
    case "ssh":
      return `${transport.host}${suffix}`;
    case "wsl":
      return `WSL ${transport.distro}${suffix}`;
  }
}

export function serverAddressSummary(server: ServerAddress): string {
  const transport = server.transport;
  switch (transport?.kind) {
    case "local":
      return `local instance: ${transport.instance}`;
    case "ssh":
      return `ssh ${transport.host}, instance ${transport.instance}`;
    case "wsl":
      return `WSL ${transport.distro} as ${transport.user}, instance ${transport.instance}`;
    default:
      return server.url;
  }
}
