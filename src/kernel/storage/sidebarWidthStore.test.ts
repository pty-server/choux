import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIndexedDB } from "./setup";
import { metaStoreName, openDatabase, resetDbMemo } from "./db";
import {
  clampSidebarWidth,
  defaultSidebarWidth,
  getSidebarWidth,
  maxSidebarWidth,
  minSidebarWidth,
  saveSidebarWidth,
} from "./sidebarWidthStore";

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

beforeEach(resetState);
afterEach(resetState);

async function putRaw(value: unknown): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(value, "sidebarWidth");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("clampSidebarWidth", () => {
  it("keeps a width inside the allowed range", () => {
    expect(clampSidebarWidth(320)).toBe(320);
  });

  it("clamps to the bounds rather than rejecting", () => {
    expect(clampSidebarWidth(10)).toBe(minSidebarWidth);
    expect(clampSidebarWidth(9000)).toBe(maxSidebarWidth);
  });

  it("rounds fractional widths from a drag", () => {
    expect(clampSidebarWidth(320.6)).toBe(321);
  });

  it("falls back to the default for anything that is not a finite number", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(defaultSidebarWidth);
    expect(clampSidebarWidth("300")).toBe(defaultSidebarWidth);
    expect(clampSidebarWidth(undefined)).toBe(defaultSidebarWidth);
  });
});

describe("sidebar width store", () => {
  it("uses the default until a width is saved", async () => {
    expect(await getSidebarWidth()).toBe(defaultSidebarWidth);
  });

  it("persists a width across reopens", async () => {
    await saveSidebarWidth(400);
    resetDbMemo();

    expect(await getSidebarWidth()).toBe(400);
  });

  it("clamps on the way in, so a stored width is always usable", async () => {
    await saveSidebarWidth(9000);
    resetDbMemo();

    expect(await getSidebarWidth()).toBe(maxSidebarWidth);
  });

  it("ignores a malformed stored value", async () => {
    await putRaw("wide");
    resetDbMemo();

    expect(await getSidebarWidth()).toBe(defaultSidebarWidth);
  });
});
