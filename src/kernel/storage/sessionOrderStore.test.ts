import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetIndexedDB } from "./setup";
import { metaStoreName, openDatabase, resetDbMemo } from "./db";
import {
  getSessionOrder,
  normalizeSessionOrder,
  orderSessions,
  reorderSessionIds,
  saveSessionOrder,
  sessionOrderScope,
} from "./sessionOrderStore";

function resetState(): void {
  resetIndexedDB();
  resetDbMemo();
}

beforeEach(resetState);
afterEach(resetState);

async function putRaw(value: unknown): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(metaStoreName, "readwrite").objectStore(metaStoreName).put(value, "sessionOrder");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function sessions(...ids: string[]): { id: string }[] {
  return ids.map((id) => ({ id }));
}

describe("sessionOrderScope", () => {
  it("keeps servers with the same workspace id apart", () => {
    expect(sessionOrderScope("one", "w")).not.toBe(sessionOrderScope("two", "w"));
  });
});

describe("orderSessions", () => {
  it("returns the input untouched with no saved order", () => {
    const input = sessions("a", "b");

    expect(orderSessions(input, undefined)).toBe(input);
    expect(orderSessions(input, [])).toBe(input);
  });

  it("arranges sessions by the saved order", () => {
    expect(orderSessions(sessions("a", "b", "c"), ["c", "a", "b"]).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("puts sessions the order has never seen first", () => {
    expect(orderSessions(sessions("new", "a", "b"), ["b", "a"]).map((s) => s.id)).toEqual(["new", "b", "a"]);
  });

  it("ignores ids of sessions that are gone", () => {
    expect(orderSessions(sessions("a"), ["gone", "a"]).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("reorderSessionIds", () => {
  it("moves an id above its drop target", () => {
    expect(reorderSessionIds(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
  });

  it("moves an id below its drop target", () => {
    expect(reorderSessionIds(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
  });

  it("moves an id down to just above a later target", () => {
    expect(reorderSessionIds(["a", "b", "c"], "a", "c", "before")).toEqual(["b", "a", "c"]);
  });

  it("leaves the order alone when a drop lands on the dragged row", () => {
    expect(reorderSessionIds(["a", "b"], "a", "a", "before")).toEqual(["a", "b"]);
  });

  it("leaves the order alone when either id is unknown", () => {
    expect(reorderSessionIds(["a", "b"], "gone", "a", "before")).toEqual(["a", "b"]);
    expect(reorderSessionIds(["a", "b"], "a", "gone", "before")).toEqual(["a", "b"]);
  });
});

describe("normalizeSessionOrder", () => {
  it("drops non-string and duplicate ids", () => {
    expect(normalizeSessionOrder({ scope: ["a", "a", 7, "b"] })).toEqual({ scope: ["a", "b"] });
  });

  it("drops scopes that are not arrays or end up empty", () => {
    expect(normalizeSessionOrder({ bad: "a", empty: [], gone: [1] })).toEqual({});
  });

  it("falls back to an empty order for a malformed value", () => {
    expect(normalizeSessionOrder("nope")).toEqual({});
    expect(normalizeSessionOrder(null)).toEqual({});
  });
});

describe("session order store", () => {
  it("starts empty", async () => {
    expect(await getSessionOrder()).toEqual({});
  });

  it("persists an order across reopens", async () => {
    await saveSessionOrder({ "one:w": ["b", "a"] });
    resetDbMemo();

    expect(await getSessionOrder()).toEqual({ "one:w": ["b", "a"] });
  });

  it("normalizes on the way in, so a stored order is always usable", async () => {
    await saveSessionOrder({ "one:w": ["a", "a", "b"] });
    resetDbMemo();

    expect(await getSessionOrder()).toEqual({ "one:w": ["a", "b"] });
  });

  it("ignores a malformed stored value", async () => {
    await putRaw("ordered");
    resetDbMemo();

    expect(await getSessionOrder()).toEqual({});
  });
});
