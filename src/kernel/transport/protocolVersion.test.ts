import { describe, expect, it } from "vitest";
import { protocolMismatch } from "./protocolVersion";

describe("protocolMismatch", () => {
  it("returns false for matching versions", () => {
    expect(protocolMismatch(1, 1)).toBe(false);
  });

  it("returns true for mismatched versions", () => {
    expect(protocolMismatch(1, 2)).toBe(true);
  });
});
