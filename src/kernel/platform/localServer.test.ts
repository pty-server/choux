import { describe, expect, it } from "vitest";
import { localServerEndpoint } from "./localServer";

describe("localServerEndpoint", () => {
  it("keeps an instance in a URL-shaped placeholder for native transport", () => {
    expect(localServerEndpoint("work.dev")).toBe("http://work.dev.ptys.local");
  });
});
