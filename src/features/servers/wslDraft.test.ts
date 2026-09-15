import { describe, expect, it } from "vitest";
import { sameTransport } from "../../registry/serverTransport";
import { detectSummary, emptyWslFields, wslFields, wslFieldsTransport, wslProblem } from "./wslDraft";

describe("detectSummary", () => {
  it("prefers the problem found, then the ptys version, then the missing ptys", () => {
    const found = { user: "me", nodeAvailable: true, npmAvailable: true };

    expect(detectSummary({ ...found, nodeAvailable: false, message: "Node.js is not installed in Debian." })).toBe("Node.js is not installed in Debian.");
    expect(detectSummary({ ...found, ptysVersion: "0.3.0" })).toBe("Found ptys 0.3.0 for me.");
    expect(detectSummary(found)).toBe("Found Node.js for me, but ptys is not installed there yet.");
  });
});

describe("wslFields", () => {
  it("reads a stored WSL transport into editable text fields", () => {
    expect(wslFields({ kind: "wsl", distro: "Debian", user: "me", instance: "work", nodeBin: "/opt/node/bin" }))
      .toEqual({ distro: "Debian", user: "me", instance: "work", nodeBin: "/opt/node/bin" });
  });

  it.each([
    [{ kind: "wsl", distro: 1, user: null }, { distro: "", user: "", instance: "", nodeBin: "" }],
    [null, emptyWslFields()],
    [{ kind: "ssh", host: "box", instance: "default" }, emptyWslFields()],
  ])("turns a malformed stored value %j into strings instead of throwing", (stored, fields) => {
    const read = wslFields(stored);

    expect(read).toEqual(fields);
    expect(() => wslProblem(read)).not.toThrow();
  });
});

describe("wslFieldsTransport", () => {
  it("trims the fields and leaves out an empty node directory", () => {
    expect(wslFieldsTransport({ distro: " Debian ", user: " me ", instance: " default ", nodeBin: " " }))
      .toEqual({ kind: "wsl", distro: "Debian", user: "me", instance: "default" });
  });

  it("round-trips a stored transport without reporting a change", () => {
    const stored = { kind: "wsl", distro: "Debian", user: "me", instance: "default", nodeBin: "/opt/node/bin" };

    expect(sameTransport(stored, wslFieldsTransport(wslFields(stored)))).toBe(true);
  });
});

describe("wslProblem", () => {
  it("asks for a distribution and a user first, then reports the first invalid field", () => {
    expect(wslProblem(emptyWslFields())).toBe("Choose a WSL distribution.");
    expect(wslProblem(emptyWslFields("Debian"))).toContain("Linux user");
    expect(wslProblem({ distro: "Debian", user: "me", instance: "default", nodeBin: "/mnt/c/nodejs" })).toContain("Windows drive");
    expect(wslProblem({ distro: "Debian", user: "me", instance: "default", nodeBin: "" })).toBeUndefined();
  });
});
