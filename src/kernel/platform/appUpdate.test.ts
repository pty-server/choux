import { describe, expect, it, vi } from "vitest";
import { trackDownloadProgress } from "./appUpdate";

describe("trackDownloadProgress", () => {
  it("reports the downloaded fraction when the size is known", () => {
    const onProgress = vi.fn();
    const track = trackDownloadProgress(onProgress);

    track({ event: "Started", data: { contentLength: 200 } });
    track({ event: "Progress", data: { chunkLength: 50 } });
    track({ event: "Progress", data: { chunkLength: 100 } });
    track({ event: "Finished" });

    expect(onProgress.mock.calls.map(([fraction]) => fraction)).toEqual([0, 0.25, 0.75, 1]);
  });

  it("reports no fraction when the server sends no size", () => {
    const onProgress = vi.fn();
    const track = trackDownloadProgress(onProgress);

    track({ event: "Started", data: {} });
    track({ event: "Progress", data: { chunkLength: 50 } });

    expect(onProgress.mock.calls.map(([fraction]) => fraction)).toEqual([undefined, undefined]);
  });

  it("never reports more than the whole download", () => {
    const onProgress = vi.fn();
    const track = trackDownloadProgress(onProgress);

    track({ event: "Started", data: { contentLength: 10 } });
    track({ event: "Progress", data: { chunkLength: 25 } });

    expect(onProgress).toHaveBeenLastCalledWith(1);
  });
});
