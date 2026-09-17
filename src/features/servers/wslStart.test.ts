import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerStatus } from "../../registry/types";
import type { WslDistro } from "../../registry/wsl";
import { stoppedWslTransport, waitUntilOnline, type StartableServer } from "./wslStart";

const debian: WslDistro = { name: "Debian", default: true, running: false, version: 2 };
const ubuntu: WslDistro = { name: "Ubuntu", default: false, running: true, version: 2 };

function server(transport: unknown, status: ServerStatus = "offline"): StartableServer {
  return { status, config: { transport } };
}

const wslTransport = { kind: "wsl", distro: "Debian", user: "kajoj", instance: "default" };

describe("stoppedWslTransport", () => {
  it("offers the transport when its distribution is listed as stopped", () => {
    expect(stoppedWslTransport(server(wslTransport), [debian, ubuntu])).toEqual(wslTransport);
  });

  it("stays quiet for a running distribution or an already connected server", () => {
    expect(stoppedWslTransport(server({ ...wslTransport, distro: "Ubuntu" }), [debian, ubuntu])).toBeUndefined();
    expect(stoppedWslTransport(server(wslTransport, "online"), [debian, ubuntu])).toBeUndefined();
  });

  it("stays quiet when the distribution is unknown, so a stale list cannot invent a Start button", () => {
    expect(stoppedWslTransport(server(wslTransport), [ubuntu])).toBeUndefined();
    expect(stoppedWslTransport(server(wslTransport), [])).toBeUndefined();
  });

  it("ignores servers that are not reached through WSL", () => {
    expect(stoppedWslTransport(server(undefined), [debian])).toBeUndefined();
    expect(stoppedWslTransport(server({ kind: "local", instance: "default" }), [debian])).toBeUndefined();
    expect(stoppedWslTransport(server({ kind: "wsl", distro: "Debian", user: "", instance: "default" }), [debian])).toBeUndefined();
  });
});

describe("waitUntilOnline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps polling while the daemon is still coming up, then reports the connection", async () => {
    let status: ServerStatus = "offline";
    let polls = 0;
    const refresh = () => {
      polls += 1;
      if (polls === 3) status = "online";
    };

    const settled = waitUntilOnline(() => status, refresh, 10, 100);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await settled).toBe(true);
    expect(polls).toBe(3);
  });

  it("gives up after the last attempt so a distribution that never serves is reported", async () => {
    let polls = 0;

    const settled = waitUntilOnline(() => "offline", () => { polls += 1; }, 4, 100);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await settled).toBe(false);
    expect(polls).toBe(4);
  });
});
