export interface SessionProfile {
  id: string;
  name: string;
  /** Empty means the server picks the default shell. */
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SessionProfiles {
  profiles: SessionProfile[];
  /** Used by the sidebar's New session button. Absent = ask the server for its default shell. */
  defaultProfileId?: string;
}

export const defaultSessionProfiles: SessionProfiles = { profiles: [] };

export const maxSessionProfiles = 50;
export const maxProfileNameLength = 80;
export const maxProfileArgs = 64;
export const maxProfileEnvEntries = 64;

/** Text form of a profile, as the settings rows edit it. */
export interface SessionProfileDraft {
  id: string;
  name: string;
  cmd: string;
  argsText: string;
  envText: string;
}

const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whitespace-separated, with `"..."`/`'...'` grouping. No backslash escapes. */
export function parseArgsString(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;

  for (const char of value) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

export function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg !== "" && !/\s|["']/.test(arg)) return arg;
      // No escapes in the grammar, so pick the quote the value does not contain.
      return arg.includes("'") ? `"${arg}"` : `'${arg}'`;
    })
    .join(" ");
}

/** One `KEY=VALUE` per line. Blank and `#` lines are skipped; unparsable lines are dropped. */
export function parseEnvText(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!envKeyPattern.test(key)) continue;
    env[key] = trimmed.slice(separator + 1);
  }
  return env;
}

export function formatEnvText(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** Strict counterpart of `parseEnvText`, used to gate the settings Save button. */
export function envTextError(value: string): string | undefined {
  const lines = value.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) return `Line ${index + 1} is not KEY=VALUE.`;
    const key = trimmed.slice(0, separator).trim();
    if (!envKeyPattern.test(key)) return `Line ${index + 1} has an invalid variable name.`;
  }
  return undefined;
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, entry]) => envKeyPattern.test(key) && typeof entry === "string")
    .slice(0, maxProfileEnvEntries) as [string, string][];
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function normalizeProfile(value: unknown): SessionProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const saved = value as Record<string, unknown>;
  if (typeof saved.id !== "string" || saved.id === "") return undefined;
  if (typeof saved.name !== "string" || saved.name.trim() === "") return undefined;
  const env = normalizeEnv(saved.env);
  const profile: SessionProfile = {
    id: saved.id,
    name: saved.name.trim().slice(0, maxProfileNameLength),
    cmd: typeof saved.cmd === "string" ? saved.cmd.trim() : "",
    args: Array.isArray(saved.args) ? saved.args.filter((arg): arg is string => typeof arg === "string").slice(0, maxProfileArgs) : [],
  };
  if (env) profile.env = env;
  return profile;
}

export function normalizeSessionProfiles(value: unknown): SessionProfiles {
  if (!value || typeof value !== "object") return { profiles: [] };
  const saved = value as Record<string, unknown>;
  const profiles: SessionProfile[] = [];
  const seen = new Set<string>();
  if (Array.isArray(saved.profiles)) {
    for (const entry of saved.profiles) {
      if (profiles.length >= maxSessionProfiles) break;
      const profile = normalizeProfile(entry);
      if (!profile || seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
    }
  }
  const normalized: SessionProfiles = { profiles };
  if (typeof saved.defaultProfileId === "string" && seen.has(saved.defaultProfileId)) {
    normalized.defaultProfileId = saved.defaultProfileId;
  }
  return normalized;
}

export function cloneSessionProfiles(value: SessionProfiles): SessionProfiles {
  const clone: SessionProfiles = {
    profiles: value.profiles.map((profile) => ({
      ...profile,
      args: [...profile.args],
      ...(profile.env ? { env: { ...profile.env } } : {}),
    })),
  };
  if (value.defaultProfileId !== undefined) clone.defaultProfileId = value.defaultProfileId;
  return clone;
}

function envEqual(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b ?? {}).sort(([x], [y]) => x.localeCompare(y));
  if (left.length !== right.length) return false;
  return left.every(([key, value], index) => right[index][0] === key && right[index][1] === value);
}

export function sessionProfilesEqual(a: SessionProfiles, b: SessionProfiles): boolean {
  if ((a.defaultProfileId ?? "") !== (b.defaultProfileId ?? "")) return false;
  if (a.profiles.length !== b.profiles.length) return false;
  return a.profiles.every((profile, index) => {
    const other = b.profiles[index];
    return (
      profile.id === other.id &&
      profile.name === other.name &&
      profile.cmd === other.cmd &&
      profile.args.length === other.args.length &&
      profile.args.every((arg, argIndex) => arg === other.args[argIndex]) &&
      envEqual(profile.env, other.env)
    );
  });
}

export function findSessionProfile(value: SessionProfiles, id: string): SessionProfile | undefined {
  return value.profiles.find((profile) => profile.id === id);
}

export function resolveDefaultProfile(value: SessionProfiles): SessionProfile | undefined {
  if (value.defaultProfileId === undefined) return undefined;
  return findSessionProfile(value, value.defaultProfileId);
}

export function profileCommandId(profileId: string): string {
  return `session.profile.${profileId}`;
}

export function profileCommandTitle(profile: SessionProfile): string {
  return `New session: ${profile.name}`;
}

/** Spreadable into a session-create input; omits everything the profile leaves blank. */
export function profileLaunchInput(profile: SessionProfile): {
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
  name?: string;
} {
  const input: { cmd?: string; args?: string[]; env?: Record<string, string>; name?: string } = { name: profile.name };
  if (profile.cmd !== "") input.cmd = profile.cmd;
  if (profile.args.length > 0) input.args = [...profile.args];
  if (profile.env && Object.keys(profile.env).length > 0) input.env = { ...profile.env };
  return input;
}

export function toProfileDrafts(value: SessionProfiles): SessionProfileDraft[] {
  return value.profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    cmd: profile.cmd,
    argsText: formatArgs(profile.args),
    envText: formatEnvText(profile.env),
  }));
}

export function emptyProfileDraft(id: string): SessionProfileDraft {
  return { id, name: "", cmd: "", argsText: "", envText: "" };
}

export function fromProfileDrafts(drafts: readonly SessionProfileDraft[], defaultProfileId: string | undefined): SessionProfiles {
  return normalizeSessionProfiles({
    profiles: drafts.map((draft) => ({
      id: draft.id,
      name: draft.name,
      cmd: draft.cmd,
      args: parseArgsString(draft.argsText),
      env: parseEnvText(draft.envText),
    })),
    defaultProfileId,
  });
}

/** Non-secret reason the row cannot be saved, or undefined when it is valid. */
export function sessionProfileDraftError(draft: SessionProfileDraft): string | undefined {
  if (draft.name.trim() === "") return "Name is required.";
  return envTextError(draft.envText);
}
