export const PTYS_LATEST_URL = "https://registry.npmjs.org/@pty-server%2fptys/latest";

export const PTYS_UPDATE_COMMAND = "npm i -g @pty-server/ptys";

export const PTYS_RELEASE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareVersions(leftVersion: string, rightVersion: string): number | undefined {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) return undefined;
  const coreOrder = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (coreOrder !== 0) return coreOrder;
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (const [index, identifier] of left.prerelease.entries()) {
    const other = right.prerelease[index];
    if (other === undefined) return 1;
    const order = comparePrereleaseIdentifiers(identifier, other);
    if (order !== 0) return order;
  }
  return left.prerelease.length - right.prerelease.length;
}

export function ptysUpdateFor(installed: string | undefined, latest: string | undefined): string | undefined {
  if (installed === undefined || latest === undefined) return undefined;
  const order = compareVersions(installed, latest);
  return order !== undefined && order < 0 ? latest : undefined;
}

export async function fetchLatestPtysVersion(fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl(PTYS_LATEST_URL);
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const version = typeof body === "object" && body !== null && "version" in body ? body.version : undefined;
    return typeof version === "string" && parseVersion(version) ? version : undefined;
  } catch {
    return undefined;
  }
}
