import { describe, expect, it } from "vitest";
import type { ServerStatus } from "../../registry/types";
import type { WslDistro } from "../../registry/wsl";
import { stoppedWslTransport, type StartableServer } from "./wslStart";

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
