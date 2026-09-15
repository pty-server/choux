import { describe, expect, it } from "vitest";
import type { WslDistro, WslProbe, WslStatus } from "../../registry/wsl";
import { wslDialogStage } from "./wslDialog";

const debian: WslDistro = { name: "Debian", default: true, running: false, version: 2 };
const legacy: WslDistro = { name: "Legacy", default: false, running: true, version: 1 };
const ready: WslStatus = { supported: true, version: "2.7.14.0", distros: [debian, legacy] };

function probe(overrides: Partial<WslProbe> = {}): WslProbe {
  return { user: "me", nodeAvailable: true, npmAvailable: true, ...overrides };
}

describe("wslDialogStage", () => {
  it("waits for the status, then reports a WSL problem or a missing distribution", () => {
    expect(wslDialogStage(undefined, undefined, undefined)).toEqual({ kind: "loading" });
    expect(wslDialogStage({ supported: true, problem: "Run wsl --update", distros: [] }, undefined, undefined))
      .toEqual({ kind: "problem", problem: "Run wsl --update" });
    expect(wslDialogStage({ supported: true, distros: [] }, undefined, undefined)).toEqual({ kind: "no-distros" });
  });

  it("refuses a WSL 1 distribution before checking it", () => {
    expect(wslDialogStage(ready, "Legacy", probe({ ptysVersion: "0.3.0" }))).toEqual({ kind: "wsl1", distro: legacy });
  });

  it("asks for a check until the selected distribution has been probed", () => {
    expect(wslDialogStage(ready, "Debian", undefined)).toEqual({ kind: "unchecked", distro: debian });
    expect(wslDialogStage(ready, "Gone", undefined)).toEqual({ kind: "unchecked", distro: debian });
  });

  it("walks from a missing Node.js to installing and starting ptys", () => {
    expect(wslDialogStage(ready, "Debian", probe({ nodeAvailable: false, npmAvailable: false, message: "Node.js is not installed in Debian." })))
      .toEqual({ kind: "no-node", distro: debian, message: "Node.js is not installed in Debian." });
    expect(wslDialogStage(ready, "Debian", probe())).toEqual({ kind: "install", distro: debian });
    expect(wslDialogStage(ready, "Debian", probe({ npmAvailable: false, message: "Neither ptys nor npm is on the PATH." })))
      .toEqual({ kind: "no-ptys", distro: debian, message: "Neither ptys nor npm is on the PATH." });
    expect(wslDialogStage(ready, "Debian", probe({ ptysVersion: "0.3.0" }))).toEqual({ kind: "ready", distro: debian, ptysVersion: "0.3.0" });
  });
});
