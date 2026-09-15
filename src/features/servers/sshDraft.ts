import { DEFAULT_INSTANCE, transportKind, transportProblem, type ServerTransport } from "../../registry/serverTransport";

export interface SshFields {
  host: string;
  instance: string;
  nodeBin: string;
}

export function emptySshFields(): SshFields {
  return { host: "", instance: DEFAULT_INSTANCE, nodeBin: "" };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function sshFields(transport: unknown): SshFields {
  if (transportKind(transport) !== "ssh") return emptySshFields();
  const stored = transport as Record<string, unknown>;
  return { host: text(stored.host), instance: text(stored.instance), nodeBin: text(stored.nodeBin) };
}

export function sshTransport(fields: SshFields): ServerTransport {
  const nodeBin = fields.nodeBin.trim();
  return { kind: "ssh", host: fields.host.trim(), instance: fields.instance.trim(), ...(nodeBin === "" ? {} : { nodeBin }) };
}

export function sshProblem(fields: SshFields): string | undefined {
  return fields.host.trim() === "" ? "An SSH host is required." : transportProblem(sshTransport(fields));
}
