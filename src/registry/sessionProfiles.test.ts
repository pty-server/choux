import { describe, expect, it } from "vitest";
import {
  defaultSessionProfiles,
  emptyProfileDraft,
  envTextError,
  formatArgs,
  formatEnvText,
  fromProfileDrafts,
  maxSessionProfiles,
  normalizeSessionProfiles,
  parseArgsString,
  parseEnvText,
  profileCommandId,
  profileCommandTitle,
  profileLaunchInput,
  resolveDefaultProfile,
  sessionProfileDraftError,
  sessionProfilesEqual,
  toProfileDrafts,
  type SessionProfile,
  type SessionProfiles,
} from "./sessionProfiles";

function profile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return { id: "p1", name: "tmux", cmd: "tmux", args: ["new-session", "-A"], ...overrides };
}

describe("parseArgsString", () => {
  it("splits on whitespace runs", () => {
    expect(parseArgsString("  -i   --login ")).toEqual(["-i", "--login"]);
  });

  it("groups quoted values", () => {
    expect(parseArgsString('--prompt "be brief" -x')).toEqual(["--prompt", "be brief", "-x"]);
    expect(parseArgsString("--msg 'two words'")).toEqual(["--msg", "two words"]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseArgsString("")).toEqual([]);
    expect(parseArgsString("   ")).toEqual([]);
  });

  it("keeps the remainder of an unterminated quote as one token", () => {
    expect(parseArgsString('-c "echo hi')).toEqual(["-c", "echo hi"]);
  });

  it("keeps an explicitly empty argument", () => {
    expect(parseArgsString("-c ''")).toEqual(["-c", ""]);
  });

  it("round-trips through formatArgs", () => {
    for (const args of [["-i", "--login"], ["--prompt", "be brief"], ["-c", ""], ["it's", "fine"]]) {
      expect(parseArgsString(formatArgs(args))).toEqual(args);
    }
  });
});

describe("env text", () => {
  it("parses KEY=VALUE lines", () => {
    expect(parseEnvText("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("splits at the first equals only", () => {
    expect(parseEnvText("A=b=c")).toEqual({ A: "b=c" });
  });

  it("skips blank and commented lines", () => {
    expect(parseEnvText("\n# a comment\nFOO=bar\n  \n")).toEqual({ FOO: "bar" });
  });

  it("drops unparsable lines but reports them strictly", () => {
    expect(parseEnvText("FOO=bar\nnope")).toEqual({ FOO: "bar" });
    expect(envTextError("FOO=bar\nnope")).toBe("Line 2 is not KEY=VALUE.");
    expect(envTextError("1BAD=x")).toBe("Line 1 has an invalid variable name.");
    expect(envTextError("FOO=bar\n# fine\n")).toBeUndefined();
  });

  it("round-trips through formatEnvText", () => {
    const env = { FOO: "bar", PATH_EXTRA: "/opt/bin" };
    expect(parseEnvText(formatEnvText(env))).toEqual(env);
    expect(formatEnvText(undefined)).toBe("");
  });
});

describe("normalizeSessionProfiles", () => {
  it("returns an empty collection for anything unusable", () => {
    for (const value of [undefined, null, 42, "x", {}, { profiles: "no" }]) {
      expect(normalizeSessionProfiles(value)).toEqual({ profiles: [] });
    }
  });

  it("drops entries without an id or a name", () => {
    const value = { profiles: [{ id: "", name: "a" }, { id: "b" }, { id: "c", name: "  " }, profile()] };
    expect(normalizeSessionProfiles(value).profiles).toEqual([profile()]);
  });

  it("dedupes by id, keeping the first", () => {
    const value = { profiles: [profile(), profile({ name: "later" })] };
    expect(normalizeSessionProfiles(value).profiles).toEqual([profile()]);
  });

  it("drops a dangling default and keeps a valid one", () => {
    expect(normalizeSessionProfiles({ profiles: [profile()], defaultProfileId: "gone" })).toEqual({ profiles: [profile()] });
    expect(normalizeSessionProfiles({ profiles: [profile()], defaultProfileId: "p1" }).defaultProfileId).toBe("p1");
  });

  it("coerces cmd, args, and env", () => {
    const normalized = normalizeSessionProfiles({
      profiles: [{ id: "p1", name: " tmux ", cmd: 7, args: ["a", 3, "b"], env: { FOO: "bar", BAD: 1, "1x": "y" } }],
    });
    expect(normalized.profiles[0]).toEqual({ id: "p1", name: "tmux", cmd: "", args: ["a", "b"], env: { FOO: "bar" } });
  });

  it("omits an empty env entirely", () => {
    expect(normalizeSessionProfiles({ profiles: [{ ...profile(), env: {} }] }).profiles[0].env).toBeUndefined();
  });

  it("clamps the collection length", () => {
    const many = Array.from({ length: maxSessionProfiles + 5 }, (_, i) => profile({ id: `p${i}` }));
    expect(normalizeSessionProfiles({ profiles: many }).profiles).toHaveLength(maxSessionProfiles);
  });
});

describe("default resolution", () => {
  it("has no default out of the box", () => {
    expect(resolveDefaultProfile(defaultSessionProfiles)).toBeUndefined();
  });

  it("has no default when the id names nothing", () => {
    expect(resolveDefaultProfile({ profiles: [profile()], defaultProfileId: "gone" })).toBeUndefined();
    expect(resolveDefaultProfile({ profiles: [], defaultProfileId: "p1" })).toBeUndefined();
  });

  it("resolves a marked default", () => {
    expect(resolveDefaultProfile({ profiles: [profile()], defaultProfileId: "p1" })).toEqual(profile());
  });
});

describe("launch helpers", () => {
  it("omits everything the profile leaves blank", () => {
    expect(profileLaunchInput({ id: "p1", name: "shell", cmd: "", args: [] })).toEqual({ name: "shell" });
  });

  it("passes cmd, args, and env through", () => {
    expect(profileLaunchInput(profile({ env: { FOO: "bar" } }))).toEqual({
      name: "tmux",
      cmd: "tmux",
      args: ["new-session", "-A"],
      env: { FOO: "bar" },
    });
  });

  it("names commands predictably", () => {
    expect(profileCommandId("p1")).toBe("session.profile.p1");
    expect(profileCommandTitle(profile())).toBe("New session: tmux");
  });
});

describe("drafts", () => {
  const profiles: SessionProfiles = {
    profiles: [profile({ env: { FOO: "bar" } }), profile({ id: "p2", name: "ssh", cmd: "ssh", args: ["prod"] })],
    defaultProfileId: "p2",
  };

  it("round-trips a collection", () => {
    expect(fromProfileDrafts(toProfileDrafts(profiles), profiles.defaultProfileId)).toEqual(profiles);
  });

  it("normalizes what the rows produce", () => {
    const rows = [{ ...emptyProfileDraft("p1"), name: "x", envText: "junk" }];
    expect(fromProfileDrafts(rows, "nope")).toEqual({ profiles: [{ id: "p1", name: "x", cmd: "", args: [] }] });
  });

  it("reports unsavable rows", () => {
    expect(sessionProfileDraftError(emptyProfileDraft("p1"))).toBe("Name is required.");
    expect(sessionProfileDraftError({ ...emptyProfileDraft("p1"), name: "x", envText: "FOO bar" })).toBe("Line 1 is not KEY=VALUE.");
    expect(sessionProfileDraftError({ ...emptyProfileDraft("p1"), name: "x", envText: "FOO=bar" })).toBeUndefined();
  });
});

describe("sessionProfilesEqual", () => {
  it("ignores env key order", () => {
    const a: SessionProfiles = { profiles: [profile({ env: { A: "1", B: "2" } })] };
    const b: SessionProfiles = { profiles: [profile({ env: { B: "2", A: "1" } })] };
    expect(sessionProfilesEqual(a, b)).toBe(true);
  });

  it("catches every field change", () => {
    const base: SessionProfiles = { profiles: [profile()], defaultProfileId: "p1" };
    expect(sessionProfilesEqual(base, { profiles: [profile({ name: "other" })], defaultProfileId: "p1" })).toBe(false);
    expect(sessionProfilesEqual(base, { profiles: [profile({ cmd: "bash" })], defaultProfileId: "p1" })).toBe(false);
    expect(sessionProfilesEqual(base, { profiles: [profile({ args: ["new-session"] })], defaultProfileId: "p1" })).toBe(false);
    expect(sessionProfilesEqual(base, { profiles: [profile({ env: { A: "1" } })], defaultProfileId: "p1" })).toBe(false);
    expect(sessionProfilesEqual(base, { profiles: [profile()] })).toBe(false);
    expect(sessionProfilesEqual(base, { profiles: [], defaultProfileId: "p1" })).toBe(false);
  });
});
