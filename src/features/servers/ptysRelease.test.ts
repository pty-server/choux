import { describe, expect, it, vi } from "vitest";
import { compareVersions, fetchLatestPtysVersion, PTYS_LATEST_URL, ptysUpdateFor } from "./ptysRelease";

describe("compareVersions", () => {
  it.each([
    ["0.1.1", "0.2.0", -1],
    ["0.2.0", "0.2.0", 0],
    ["1.0.0", "0.9.9", 1],
    ["0.2.10", "0.2.9", 1],
    ["0.1.0-next.5", "0.1.0", -1],
    ["0.1.0", "0.1.0-next.5", 1],
    ["0.1.0-next.5", "0.1.0-next.10", -1],
    ["0.1.0-next.5", "0.1.0-next", 1],
    ["0.1.0-next", "0.1.0-next.5", -1],
    ["0.1.0-alpha", "0.1.0-1", 1],
    ["0.1.0-alpha", "0.1.0-beta", -1],
    ["v0.2.0", "0.2.0", 0],
    ["0.2.0+build.1", "0.2.0", 0],
  ])("orders %s against %s as %i", (left, right, expected) => {
    expect(Math.sign(compareVersions(left, right) ?? Number.NaN)).toBe(expected);
  });

  it.each([["dev", "0.2.0"], ["0.2.0", ""], ["0.2", "0.2.0"]])("cannot order %s against %s", (left, right) => {
    expect(compareVersions(left, right)).toBeUndefined();
  });
});

describe("ptysUpdateFor", () => {
  it("offers the latest release to an older server", () => {
    expect(ptysUpdateFor("0.1.1", "0.2.0")).toBe("0.2.0");
    expect(ptysUpdateFor("0.2.0-next.1", "0.2.0")).toBe("0.2.0");
  });

  it.each([
    ["0.2.0", "0.2.0"],
    ["0.3.0-next.0", "0.2.0"],
    [undefined, "0.2.0"],
    ["0.1.1", undefined],
    ["dev", "0.2.0"],
  ])("offers nothing to %s when the latest is %s", (installed, latest) => {
    expect(ptysUpdateFor(installed, latest)).toBeUndefined();
  });
});

describe("fetchLatestPtysVersion", () => {
  it("reads the version of the latest dist-tag", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ name: "@pty-server/ptys", version: "0.2.0" })));
    await expect(fetchLatestPtysVersion(fetchImpl)).resolves.toBe("0.2.0");
    expect(fetchImpl).toHaveBeenCalledWith(PTYS_LATEST_URL);
  });

  it.each([
    ["a failed response", () => Promise.resolve(new Response("not found", { status: 404 }))],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a body that is not JSON", () => Promise.resolve(new Response("<html>"))],
    ["a body without a version", () => Promise.resolve(new Response(JSON.stringify({ name: "@pty-server/ptys" })))],
    ["an unparseable version", () => Promise.resolve(new Response(JSON.stringify({ version: "latest" })))],
  ])("resolves to undefined on %s", async (_case, respond) => {
    await expect(fetchLatestPtysVersion(vi.fn<typeof fetch>(respond))).resolves.toBeUndefined();
  });
});
