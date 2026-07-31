import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIndexedDB } from "./setup";
import { metaStoreName, openDatabase, resetDbMemo } from "./db";
import { defaultEventSettings, normalizeEventSettings } from "../../registry/eventSettings";
import { getEventSettings, saveEventSettings } from "./eventSettingsStore";

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

beforeEach(resetState);
afterEach(resetState);

async function putRaw(value: unknown): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(value, "eventSettings");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("normalizeEventSettings", () => {
  it("keeps well-formed settings", () => {
    expect(normalizeEventSettings({ handleQuestions: false, revealWindow: false, followAttention: true }))
      .toEqual({ handleQuestions: false, revealWindow: false, followAttention: true });
  });

  it("falls back per field, so one bad key does not lose the others", () => {
    expect(normalizeEventSettings({ handleQuestions: "no", revealWindow: false, followAttention: true }))
      .toEqual({ handleQuestions: true, revealWindow: false, followAttention: true });
  });

  it("drops unknown keys", () => {
    expect(normalizeEventSettings({ handleQuestions: false, extra: 1 }))
      .toEqual({ handleQuestions: false, revealWindow: true, followAttention: false });
  });

  it("falls back entirely for anything that is not an object", () => {
    expect(normalizeEventSettings(undefined)).toEqual(defaultEventSettings);
    expect(normalizeEventSettings(null)).toEqual(defaultEventSettings);
    expect(normalizeEventSettings("on")).toEqual(defaultEventSettings);
  });
});

describe("event settings store", () => {
  it("handles questions and reveals, but does not follow, until told otherwise", async () => {
    expect(await getEventSettings()).toEqual(defaultEventSettings);
  });

  it("persists settings across reopens", async () => {
    await saveEventSettings({ handleQuestions: false, revealWindow: false, followAttention: true });
    resetDbMemo();

    expect(await getEventSettings()).toEqual({ handleQuestions: false, revealWindow: false, followAttention: true });
  });

  it("normalizes a partial stored record", async () => {
    await putRaw({ followAttention: true });
    resetDbMemo();

    expect(await getEventSettings()).toEqual({ handleQuestions: true, revealWindow: true, followAttention: true });
  });

  it("ignores a malformed stored value", async () => {
    await putRaw("enabled");
    resetDbMemo();

    expect(await getEventSettings()).toEqual(defaultEventSettings);
  });
});
