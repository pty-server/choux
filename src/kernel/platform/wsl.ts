import { isTauriRuntime, type TauriInvoke } from "../storage/tokenStore";
import type { WslDistro, WslHost, WslProbe, WslStatus } from "../../registry/wsl";

export interface WslBridge {
  supported(): Promise<boolean>;
  status(): Promise<WslStatus>;
  probe(distro: string, user?: string, onlyRunning?: boolean): Promise<WslProbe>;
  candidates(host: WslHost): Promise<string[]>;
  install(host: WslHost): Promise<void>;
  start(host: WslHost, instance: string): Promise<void>;
  home(host: WslHost): Promise<string | undefined>;
}

type Nullable<T> = { [Key in keyof T]-?: Exclude<T[Key], undefined> | null };

interface RawStatus extends Nullable<Omit<WslStatus, "distros">> {
  distros: Nullable<WslDistro>[];
}

function withoutNulls<T extends object>(value: Nullable<T>): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null)) as T;
}

function plainHost(host: WslHost): WslHost {
  return { distro: host.distro, user: host.user, ...(host.nodeBin === undefined ? {} : { nodeBin: host.nodeBin }) };
}

export async function getWslBridge(): Promise<WslBridge | undefined> {
  if (!isTauriRuntime()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  const call = invoke as TauriInvoke;
  return {
    supported: () => call<boolean>("wsl_supported"),
    status: async () => {
      const { distros, ...status } = await call<RawStatus>("wsl_status");
      return { ...withoutNulls<Omit<WslStatus, "distros">>(status), distros: distros.map((distro) => withoutNulls<WslDistro>(distro)) };
    },
    probe: async (distro, user, onlyRunning) => withoutNulls<WslProbe>(await call<Nullable<WslProbe>>("wsl_probe", { distro, user, onlyRunning })),
    candidates: (host) => call<string[]>("wsl_candidates", { host: plainHost(host) }),
    install: (host) => call<void>("wsl_install", { host: plainHost(host) }),
    start: (host, instance) => call<void>("wsl_start", { host: plainHost(host), instance }),
    home: async (host) => (await call<string | null>("wsl_home", { host: plainHost(host) })) ?? undefined,
  };
}
