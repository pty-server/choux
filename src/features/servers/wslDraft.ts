import { DEFAULT_INSTANCE, transportKind, transportProblem, type ServerTransport } from "../../registry/serverTransport";
import type { WslProbe } from "../../registry/wsl";

export function detectSummary(probe: WslProbe): string {
  if (probe.message !== undefined) return probe.message;
  if (probe.ptysVersion !== undefined) return `Found ptys ${probe.ptysVersion} for ${probe.user}.`;
  return `Found Node.js for ${probe.user}, but ptys is not installed there yet.`;
}

export interface WslFields {
  distro: string;
  user: string;
  instance: string;
  nodeBin: string;
}

export function emptyWslFields(distro = ""): WslFields {
  return { distro, user: "", instance: DEFAULT_INSTANCE, nodeBin: "" };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function wslFields(transport: unknown): WslFields {
  if (transportKind(transport) !== "wsl") return emptyWslFields();
  const stored = transport as Record<string, unknown>;
  return { distro: text(stored.distro), user: text(stored.user), instance: text(stored.instance), nodeBin: text(stored.nodeBin) };
}

export function wslFieldsTransport(fields: WslFields): ServerTransport {
  const nodeBin = fields.nodeBin.trim();
  return {
    kind: "wsl",
    distro: fields.distro.trim(),
    user: fields.user.trim(),
    instance: fields.instance.trim(),
    ...(nodeBin === "" ? {} : { nodeBin }),
  };
}

export function wslProblem(fields: WslFields): string | undefined {
  if (fields.distro.trim() === "") return "Choose a WSL distribution.";
  if (fields.user.trim() === "") return "A Linux user is required. Detect fills it in.";
  return transportProblem(wslFieldsTransport(fields));
}
