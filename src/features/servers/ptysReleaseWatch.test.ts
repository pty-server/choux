import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PTYS_RELEASE_CHECK_INTERVAL_MS } from "./ptysRelease";
import { createPtysReleaseWatch } from "./ptysReleaseWatch.svelte";

describe("createPtysReleaseWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks on start and again after every interval until stopped", async () => {
    const fetchLatest = vi.fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("0.2.0")
      .mockResolvedValueOnce("0.3.0");
    const watch = createPtysReleaseWatch(fetchLatest);

    const stop = watch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watch.latest).toBe("0.2.0");

    await vi.advanceTimersByTimeAsync(PTYS_RELEASE_CHECK_INTERVAL_MS);
    expect(watch.latest).toBe("0.3.0");

    stop();
    await vi.advanceTimersByTimeAsync(PTYS_RELEASE_CHECK_INTERVAL_MS);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known release when a later check fails", async () => {
    const fetchLatest = vi.fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("0.2.0")
      .mockResolvedValueOnce(undefined);
    const watch = createPtysReleaseWatch(fetchLatest);

    const stop = watch.start();
    await vi.advanceTimersByTimeAsync(PTYS_RELEASE_CHECK_INTERVAL_MS);

    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(watch.latest).toBe("0.2.0");
    stop();
  });
});
