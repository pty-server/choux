export interface TmuxWindow {
  id: string;
  index: string;
  name: string;
  active: boolean;
  command: string;
  paneTitle: string;
}

export interface TmuxPane {
  id: string;
  windowId: string;
  command: string;
  pid: string;
}

export const clientsFormat = "#{client_tty}\t#{session_name}";
export const windowsFormat = "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_command}\t#{pane_title}";
export const panesFormat = "#{pane_id}\t#{window_id}\t#{pane_current_command}\t#{pane_pid}";

function bareTty(value: string): string {
  return value.trim().replace(/^\/dev\//, "");
}

export function parseTty(stdout: string): string | undefined {
  const tty = bareTty(stdout);
  return tty.length === 0 || tty === "?" ? undefined : tty;
}

export function sessionNameForTty(stdout: string, tty: string): string | undefined {
  const wanted = bareTty(tty);
  for (const line of stdout.split("\n")) {
    const [clientTty, sessionName] = line.split("\t");
    if (sessionName === undefined) continue;
    if (bareTty(clientTty) === wanted && sessionName.length > 0) return sessionName;
  }
  return undefined;
}

export function windowDetail(window: TmuxWindow): string {
  const detail = (window.paneTitle || window.command).trim();
  return detail.toLowerCase() === window.name.trim().toLowerCase() ? "" : detail;
}

export function parsePanes(stdout: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [id, windowId, command, pid] = line.split("\t");
    if (id === undefined || windowId === undefined) continue;
    panes.push({ id, windowId, command: command ?? "", pid: (pid ?? "").trim() });
  }
  return panes;
}

export function parseWindows(stdout: string): TmuxWindow[] {
  const windows: TmuxWindow[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [id, index, name, active, command, ...paneTitle] = line.split("\t");
    if (id === undefined || index === undefined || name === undefined) continue;
    windows.push({
      id,
      index,
      name,
      active: active === "1",
      command: command ?? "",
      paneTitle: paneTitle.join("\t"),
    });
  }
  return windows;
}
