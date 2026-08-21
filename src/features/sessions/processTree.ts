import { agentLabelFor } from "./agentDetect";

export interface ProcessRow {
  pid: string;
  ppid: string;
  command: string;
}

export const processListArgs: readonly string[] = ["-eo", "pid=,ppid=,comm="];

export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const [pid, ppid, ...command] = fields;
    rows.push({ pid, ppid, command: command.join(" ") });
  }
  return rows;
}

function agentUnder(
  rootPid: string,
  children: ReadonlyMap<string, string[]>,
  commands: ReadonlyMap<string, string>,
): string | undefined {
  const visited = new Set<string>([rootPid]);
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index];
    const label = agentLabelFor(commands.get(pid));
    if (label !== undefined) return label;
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push(child);
    }
  }
  return undefined;
}

/** Agent label per root pid, for every root whose process tree still holds an agent process. */
export function subtreeAgents(
  rows: readonly ProcessRow[],
  rootPids: readonly string[],
): Record<string, string> {
  const children = new Map<string, string[]>();
  const commands = new Map<string, string>();
  for (const row of rows) {
    commands.set(row.pid, row.command);
    const siblings = children.get(row.ppid);
    if (siblings === undefined) children.set(row.ppid, [row.pid]);
    else siblings.push(row.pid);
  }
  const found: Record<string, string> = {};
  for (const rootPid of rootPids) {
    if (rootPid.length === 0 || found[rootPid] !== undefined) continue;
    const label = agentUnder(rootPid, children, commands);
    if (label !== undefined) found[rootPid] = label;
  }
  return found;
}
