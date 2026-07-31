export function agentStateKey(sessionId: string, pane: string | undefined): string {
  return pane === undefined || pane.length === 0 ? `session:${sessionId}` : `pane:${pane}`;
}

export function agentStatePane(key: string): string | undefined {
  return key.startsWith("pane:") ? key.slice("pane:".length) : undefined;
}
