import { IDBFactory, indexedDB as fakeIndexedDB } from "fake-indexeddb";

Object.assign(globalThis, { indexedDB: fakeIndexedDB });

// fake-indexeddb's deleteDatabase hangs if the DB is still open, so we
// replace the global IDBFactory instead of trying to delete databases.
export function resetIndexedDB(): void {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
}
