export function isInsecureRemote(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isPlaintext = parsed.protocol === "http:" || parsed.protocol === "ws:";
    const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]";

    return isPlaintext && !isLoopback;
  } catch {
    return false;
  }
}
