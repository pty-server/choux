import { describe, expect, it } from "vitest";
import { isInsecureRemote } from "./insecureRemote";

describe("isInsecureRemote", () => {
  it.each([
    ["http://localhost", false],
    ["http://localhost:1234", false],
    ["http://127.0.0.1", false],
    ["http://127.0.0.1:8080", false],
    ["http://192.168.1.5", true],
    ["https://example.com", false],
    ["ws://localhost", false],
    ["ws://remote.example.com", true],
    ["wss://remote.example.com", false],
    ["http://[::1]", false],
  ])("returns %s for %s", (url, expected) => {
    expect(isInsecureRemote(url)).toBe(expected);
  });
});
