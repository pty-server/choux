export function protocolMismatch(clientVersion: number, serverVersion: number): boolean {
  return clientVersion !== serverVersion;
}
