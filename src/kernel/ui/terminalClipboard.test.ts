import { describe, expect, it } from "vitest";
import {
  activeTerminalClipboard,
  clearActiveTerminalClipboard,
  decodeOsc52,
  needsMultilinePasteConfirm,
  setActiveTerminalClipboard,
  type TerminalClipboardTarget,
} from "./terminalClipboard";

function target(): TerminalClipboardTarget {
  return {
    copySelection: async () => false,
    paste: async () => {},
    selectAll: () => {},
  };
}

function encode(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe("active terminal clipboard", () => {
  it("publishes and withdraws the focused terminal", () => {
    const first = target();
    setActiveTerminalClipboard(first);
    expect(activeTerminalClipboard()).toBe(first);
    clearActiveTerminalClipboard(first);
    expect(activeTerminalClipboard()).toBeUndefined();
  });

  it("ignores a withdrawal from a terminal that was already replaced", () => {
    const first = target();
    const second = target();
    setActiveTerminalClipboard(first);
    setActiveTerminalClipboard(second);
    clearActiveTerminalClipboard(first);
    expect(activeTerminalClipboard()).toBe(second);
  });
});

describe("decodeOsc52", () => {
  it("decodes a clipboard write", () => {
    expect(decodeOsc52(`c;${encode("hello")}`)).toBe("hello");
  });

  it("decodes multi-byte text", () => {
    expect(decodeOsc52(`c;${encode("zażółć — ok")}`)).toBe("zażółć — ok");
  });

  it("accepts the primary and empty selection targets", () => {
    expect(decodeOsc52(`p;${encode("primary")}`)).toBe("primary");
    expect(decodeOsc52(`;${encode("default")}`)).toBe("default");
  });

  it("refuses read requests", () => {
    expect(decodeOsc52("c;?")).toBeUndefined();
  });

  it("refuses malformed, empty and oversized payloads", () => {
    expect(decodeOsc52("c")).toBeUndefined();
    expect(decodeOsc52("c;")).toBeUndefined();
    expect(decodeOsc52("c;not base64!")).toBeUndefined();
    expect(decodeOsc52(`z;${encode("hello")}`)).toBeUndefined();
    expect(decodeOsc52(`c;${"A".repeat(1_000_004)}`)).toBeUndefined();
  });
});

describe("needsMultilinePasteConfirm", () => {
  it("stays quiet while bracketed paste is on", () => {
    expect(needsMultilinePasteConfirm("one\ntwo", true)).toBe(false);
  });

  it("stays quiet for a single line with or without a trailing newline", () => {
    expect(needsMultilinePasteConfirm("one", false)).toBe(false);
    expect(needsMultilinePasteConfirm("one\n", false)).toBe(false);
    expect(needsMultilinePasteConfirm("one\r\n", false)).toBe(false);
  });

  it("warns when the paste would run more than one command", () => {
    expect(needsMultilinePasteConfirm("one\ntwo", false)).toBe(true);
    expect(needsMultilinePasteConfirm("one\ntwo\n", false)).toBe(true);
    expect(needsMultilinePasteConfirm("one\r", false)).toBe(true);
  });
});
