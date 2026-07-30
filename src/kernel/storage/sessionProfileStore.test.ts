import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIndexedDB } from "./setup";
import { resetDbMemo } from "./db";
import { getSessionProfiles, saveSessionProfiles } from "./sessionProfileStore";
import { defaultSessionProfiles, type SessionProfiles } from "../../registry/sessionProfiles";

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

beforeEach(resetState);
afterEach(resetState);

describe("session profiles", () => {
  it("has no profiles until some are saved", async () => {
    expect(await getSessionProfiles()).toEqual(defaultSessionProfiles);
  });

  it("persists profiles and the default marker", async () => {
    const profiles: SessionProfiles = {
      profiles: [
        { id: "p1", name: "tmux", cmd: "tmux", args: ["new-session", "-A", "-s", "main"] },
        { id: "p2", name: "dev shell", cmd: "bash", args: [], env: { FOO: "bar" } },
      ],
      defaultProfileId: "p2",
    };
    await saveSessionProfiles(profiles);
    resetDbMemo();

    expect(await getSessionProfiles()).toEqual(profiles);
  });

  it("drops unusable profiles and a dangling default", async () => {
    await saveSessionProfiles({
      profiles: [{ id: "", name: "" }, { id: "a" }],
      defaultProfileId: "nope",
    } as unknown as SessionProfiles);
    resetDbMemo();

    expect(await getSessionProfiles()).toEqual({ profiles: [] });
  });
});
