export function workspaceHue(workspaceId: string): number {
  let hash = 5381;
  for (let i = 0; i < workspaceId.length; i++) {
    hash = ((hash << 5) + hash + workspaceId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function workspaceColor(workspaceId: string): string {
  const hue = workspaceHue(workspaceId);
  return `hsl(${hue}, 55%, 42%)`;
}
