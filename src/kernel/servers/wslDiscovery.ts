import { usableDistro, wslHost, wslTransport, type WslHost, type WslStatus, type WslTransport } from "../../registry/wsl";
import type { WslBridge } from "../platform/wsl";

export interface WslDiscoverySteps {
  bridge: Pick<WslBridge, "probe" | "candidates">;
  ensureServer: (transport: WslTransport) => Promise<string>;
}

async function liveInstances(bridge: WslDiscoverySteps["bridge"], distro: string): Promise<{ host: WslHost; instances: string[] } | undefined> {
  try {
    const probe = await bridge.probe(distro, undefined, true);
    if (probe.ptysVersion === undefined) return undefined;
    const host = wslHost(distro, probe);
    return { host, instances: await bridge.candidates(host) };
  } catch {
    return undefined;
  }
}

export async function discoverWslServers(status: WslStatus, { bridge, ensureServer }: WslDiscoverySteps): Promise<string[]> {
  const serverIds: string[] = [];
  for (const distro of status.distros) {
    if (!distro.running || !usableDistro(distro)) continue;
    const found = await liveInstances(bridge, distro.name);
    for (const instance of found?.instances ?? []) {
      serverIds.push(await ensureServer(wslTransport(found!.host, instance)));
    }
  }
  return serverIds;
}
