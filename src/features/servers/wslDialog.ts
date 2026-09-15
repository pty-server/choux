import { usableDistro, type WslDistro, type WslProbe, type WslStatus } from "../../registry/wsl";

export type WslDialogStage =
  | { readonly kind: "loading" }
  | { readonly kind: "problem"; readonly problem: string }
  | { readonly kind: "no-distros" }
  | { readonly kind: "wsl1"; readonly distro: WslDistro }
  | { readonly kind: "unchecked"; readonly distro: WslDistro }
  | { readonly kind: "no-node"; readonly distro: WslDistro; readonly message: string }
  | { readonly kind: "install"; readonly distro: WslDistro }
  | { readonly kind: "no-ptys"; readonly distro: WslDistro; readonly message: string }
  | { readonly kind: "ready"; readonly distro: WslDistro; readonly ptysVersion: string };

export function wslDialogStage(
  status: WslStatus | undefined,
  distroName: string | undefined,
  probe: WslProbe | undefined,
): WslDialogStage {
  if (status === undefined) return { kind: "loading" };
  if (status.problem !== undefined) return { kind: "problem", problem: status.problem };
  const distro = status.distros.find((candidate) => candidate.name === distroName) ?? status.distros[0];
  if (distro === undefined) return { kind: "no-distros" };
  if (!usableDistro(distro)) return { kind: "wsl1", distro };
  if (probe === undefined) return { kind: "unchecked", distro };
  if (!probe.nodeAvailable) return { kind: "no-node", distro, message: probe.message ?? `Node.js is not installed in ${distro.name}.` };
  if (probe.ptysVersion !== undefined) return { kind: "ready", distro, ptysVersion: probe.ptysVersion };
  if (probe.npmAvailable) return { kind: "install", distro };
  return { kind: "no-ptys", distro, message: probe.message ?? `ptys is not installed in ${distro.name}.` };
}
