import type { ServerTransport } from "./serverTransport";

export type WslTransport = Extract<ServerTransport, { kind: "wsl" }>;

export interface WslDistro {
  readonly name: string;
  readonly default: boolean;
  readonly running: boolean;
  readonly version?: number;
}

export interface WslStatus {
  readonly supported: boolean;
  readonly version?: string;
  readonly problem?: string;
  readonly distros: readonly WslDistro[];
}

export interface WslProbe {
  readonly user: string;
  readonly home?: string;
  readonly nodeAvailable: boolean;
  readonly nodeBin?: string;
  readonly npmAvailable: boolean;
  readonly ptysVersion?: string;
  readonly message?: string;
}

export interface WslHost {
  readonly distro: string;
  readonly user: string;
  readonly nodeBin?: string;
}

export interface WslServerTools {
  readonly distros: readonly WslDistro[];
  detect(distro: string, user: string | undefined): Promise<WslProbe>;
  start(transport: WslTransport): Promise<void>;
}

export function wslHost(distro: string, found: { readonly user: string; readonly nodeBin?: string }): WslHost {
  return { distro, user: found.user, ...(found.nodeBin === undefined ? {} : { nodeBin: found.nodeBin }) };
}

export function wslTransport(host: WslHost, instance: string): WslTransport {
  return { kind: "wsl", distro: host.distro, user: host.user, instance, ...(host.nodeBin === undefined ? {} : { nodeBin: host.nodeBin }) };
}

export function usableDistro(distro: WslDistro): boolean {
  return distro.version !== 1;
}

export function defaultWslDistro(distros: readonly WslDistro[]): WslDistro | undefined {
  const usable = distros.filter(usableDistro);
  return usable.find((distro) => distro.default) ?? usable[0];
}

export function distroLabel(distro: WslDistro): string {
  const notes = [
    distro.default ? "default" : undefined,
    distro.version === 1 ? "WSL 1, not supported" : distro.running ? undefined : "stopped",
  ].filter((note) => note !== undefined);
  return notes.length === 0 ? distro.name : `${distro.name} (${notes.join(", ")})`;
}
