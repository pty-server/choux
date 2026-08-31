import { describe, expect, it } from "vitest";
import { beginKeyCapture, keyCaptureActive } from "./keyCapture";

describe("key capture claims", () => {
  it("stays active until every claim is released", () => {
    expect(keyCaptureActive()).toBe(false);

    const first = beginKeyCapture();
    const second = beginKeyCapture();
    expect(keyCaptureActive()).toBe(true);

    first();
    expect(keyCaptureActive()).toBe(true);

    second();
    expect(keyCaptureActive()).toBe(false);
  });

  it("ignores a repeated release", () => {
    const release = beginKeyCapture();
    release();
    release();

    expect(keyCaptureActive()).toBe(false);
    expect(beginKeyCapture()).toBeTypeOf("function");
  });
});
