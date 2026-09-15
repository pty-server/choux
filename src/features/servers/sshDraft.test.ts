import { describe, expect, it } from "vitest";
import { sameTransport } from "../../registry/serverTransport";
import { emptySshFields, sshFields, sshProblem, sshTransport } from "./sshDraft";

describe("sshFields", () => {
  it("reads a stored SSH transport into editable text fields", () => {
    expect(sshFields({ kind: "ssh", host: "me@box", instance: "work", nodeBin: "/opt/node/bin" }))
      .toEqual({ host: "me@box", instance: "work", nodeBin: "/opt/node/bin" });
  });

  it.each([
    [{ kind: "ssh" }, { host: "", instance: "", nodeBin: "" }],
    [{ kind: "ssh", host: 42, instance: null, nodeBin: {} }, { host: "", instance: "", nodeBin: "" }],
    [null, emptySshFields()],
    ["ssh", emptySshFields()],
    [{ kind: "local", instance: "default" }, emptySshFields()],
  ])("turns a malformed stored value %j into strings instead of throwing", (stored, fields) => {
    const read = sshFields(stored);

    expect(read).toEqual(fields);
    expect(() => sshProblem(read)).not.toThrow();
  });
});

describe("sshTransport", () => {
  it("trims the fields and leaves out an empty node directory", () => {
    expect(sshTransport({ host: " box ", instance: " default ", nodeBin: "  " })).toEqual({ kind: "ssh", host: "box", instance: "default" });
  });

  it("offers a stored empty node directory as a change, so the record can be repaired", () => {
    const stored = { kind: "ssh", host: "box", instance: "default", nodeBin: "" };

    expect(sameTransport(stored, sshTransport(sshFields(stored)))).toBe(false);
    expect(sshProblem(sshFields(stored))).toBeUndefined();
  });
});

describe("sshProblem", () => {
  it("asks for a host first, then reports the first invalid field", () => {
    expect(sshProblem(emptySshFields())).toBe("An SSH host is required.");
    expect(sshProblem({ host: "-oProxyCommand=x", instance: "default", nodeBin: "" })).toContain("SSH host");
    expect(sshProblem({ host: "box", instance: "", nodeBin: "" })).toContain("instance name");
  });
});
