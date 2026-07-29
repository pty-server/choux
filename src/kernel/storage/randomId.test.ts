import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./db";

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a valid v4 uuid via randomUUID when available", () => {
    expect(randomId()).toMatch(v4);
  });

  it("falls back to getRandomValues when randomUUID is missing (insecure context)", () => {
    // Plain-HTTP LAN origin: crypto exists but randomUUID is undefined.
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    const id = randomId();
    expect(id).toMatch(v4);
    expect(id).not.toBe(randomId());
  });

  it("falls back to Math.random when crypto is absent entirely", () => {
    vi.stubGlobal("crypto", undefined);
    expect(randomId()).toMatch(v4);
  });
});
