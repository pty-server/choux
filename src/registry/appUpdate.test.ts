import { describe, expect, it } from "vitest";
import {
  appUpdateButtonLabel,
  appUpdateStatusText,
  defaultUpdateChannel,
  installableUpdateVersion,
  normalizeUpdateChannel,
  updateChannelDescription,
  updateChannelLabel,
} from "./appUpdate";

describe("appUpdateButtonLabel", () => {
  it("offers the available version", () => {
    expect(appUpdateButtonLabel({ phase: "available", version: "0.3.0" })).toBe("Update to 0.3.0");
  });

  it("shows download progress once the size is known", () => {
    expect(appUpdateButtonLabel({ phase: "installing", version: "0.3.0", progress: undefined })).toBe("Updating…");
    expect(appUpdateButtonLabel({ phase: "installing", version: "0.3.0", progress: 0.426 })).toBe("Updating 43%");
  });

  it("offers a retry only when a failed update can still be installed", () => {
    expect(appUpdateButtonLabel({ phase: "failed", version: "0.3.0", message: "cancelled" })).toBe("Retry update");
    expect(appUpdateButtonLabel({ phase: "failed", version: undefined, message: "offline" })).toBeUndefined();
  });

  it("stays hidden while there is nothing to install", () => {
    expect(appUpdateButtonLabel({ phase: "idle" })).toBeUndefined();
    expect(appUpdateButtonLabel({ phase: "checking" })).toBeUndefined();
    expect(appUpdateButtonLabel({ phase: "current" })).toBeUndefined();
  });
});

describe("installableUpdateVersion", () => {
  it("returns the version that install would apply", () => {
    expect(installableUpdateVersion({ phase: "available", version: "0.3.0" })).toBe("0.3.0");
    expect(installableUpdateVersion({ phase: "failed", version: "0.3.0", message: "cancelled" })).toBe("0.3.0");
    expect(installableUpdateVersion({ phase: "installing", version: "0.3.0", progress: 0.5 })).toBeUndefined();
    expect(installableUpdateVersion({ phase: "current" })).toBeUndefined();
  });
});

describe("appUpdateStatusText", () => {
  it("carries the failure message", () => {
    expect(appUpdateStatusText({ phase: "failed", version: undefined, message: "offline" })).toBe("Update failed: offline");
  });
});

describe("normalizeUpdateChannel", () => {
  it("keeps a known channel", () => {
    expect(normalizeUpdateChannel("rc")).toBe("rc");
    expect(normalizeUpdateChannel("stable")).toBe("stable");
  });

  it("falls back to stable for anything else, so a corrupt setting cannot opt someone into prereleases", () => {
    expect(defaultUpdateChannel).toBe("stable");
    for (const value of [undefined, null, "", "nightly", 2, {}, ["rc"]]) {
      expect(normalizeUpdateChannel(value)).toBe("stable");
    }
  });
});

describe("update channel wording", () => {
  it("names and describes both channels differently", () => {
    expect(updateChannelLabel("stable")).not.toBe(updateChannelLabel("rc"));
    expect(updateChannelDescription("stable")).not.toBe(updateChannelDescription("rc"));
    expect(updateChannelDescription("rc")).toContain("prerelease");
  });
});
