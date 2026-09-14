import { fetchLatestPtysVersion, PTYS_RELEASE_CHECK_INTERVAL_MS } from "./ptysRelease";

export interface PtysReleaseWatch {
  readonly latest: string | undefined;
  start(): () => void;
}

export function createPtysReleaseWatch(
  fetchLatest: () => Promise<string | undefined> = () => fetchLatestPtysVersion(),
): PtysReleaseWatch {
  let latest = $state<string>();

  async function check(): Promise<void> {
    const version = await fetchLatest();
    if (version !== undefined) latest = version;
  }

  return {
    get latest() {
      return latest;
    },
    start() {
      void check();
      const interval = setInterval(() => void check(), PTYS_RELEASE_CHECK_INTERVAL_MS);
      return () => clearInterval(interval);
    },
  };
}

export const ptysReleaseWatch = createPtysReleaseWatch();
