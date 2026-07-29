// Owns the single shared IndexedDB connection for the ptys-choux app.
//
// Migration runs post-open (chained onto the memoized open promise) rather
// than inside onupgradeneeded because async chained writes across two stores
// inside a versionchange transaction are fragile - the transaction auto-commits
// once there are no pending requests queued synchronously. A plain post-open
// readwrite transaction is simpler and easier to test, and the empty-guard
// keeps it idempotent-safe.

// crypto.randomUUID is only defined in a secure context (HTTPS or localhost).
// choux runs over plain HTTP on a LAN by design, where randomUUID is undefined,
// so build a v4 UUID from crypto.getRandomValues (available in insecure
// contexts too). Falls back to Math.random only if crypto is entirely absent.
export function randomId(): string {
  const c: Crypto | undefined = typeof crypto !== "undefined" ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

const databaseName = "ptys-choux";
export const legacySettingsStoreName = "settings";
export const serversStoreName = "servers";
export const tokensStoreName = "tokens";
export const metaStoreName = "meta";
export const legacySettingsKey = "server";

// Intentionally duplicated from serverConfigStore.ts to avoid an import cycle
// (db.ts needs to be importable by serverConfigStore.ts, which also imports
// db.ts for openDatabase).
function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

let openPromise: Promise<IDBDatabase> | undefined;

export function resetDbMemo(): void {
  openPromise = undefined;
}

export function openDatabase(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;

  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 3);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(legacySettingsStoreName);
      }
      if (event.oldVersion < 2) {
        db.createObjectStore(serversStoreName, { keyPath: "id" });
        db.createObjectStore(tokensStoreName);
      }
      if (event.oldVersion < 3) {
        db.createObjectStore(metaStoreName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  openPromise = openPromise.then(async (db) => {
    await migrateLegacySettingsIfNeeded(db);
    return db;
  });

  return openPromise;
}

async function migrateLegacySettingsIfNeeded(db: IDBDatabase): Promise<void> {
  // Guard: only proceed if the servers store is empty AND legacy data exists.
  // This makes it idempotent even across separate DB connections / test runs.
  const hasServers = await new Promise<boolean>((resolve) => {
    const request = db.transaction(serversStoreName).objectStore(serversStoreName).count();
    request.onsuccess = () => resolve(request.result > 0);
    request.onerror = () => resolve(false);
  });

  if (hasServers) return;

  const legacy = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const request = db.transaction(legacySettingsStoreName).objectStore(legacySettingsStoreName).get(legacySettingsKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!legacy || typeof legacy.baseUrl !== "string" || !legacy.baseUrl) return;

  const baseUrl = legacy.baseUrl;
  const id = randomId();
  const label = hostFromUrl(baseUrl);
  const accent = "#4C6EF5"; // First entry of accentPalette (single legacy server)
  const tokenRef = id;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([serversStoreName, tokensStoreName], "readwrite");
    tx.objectStore(serversStoreName).put({ id, label, accent, url: baseUrl, tokenRef });
    tx.objectStore(tokensStoreName).put(legacy.token, tokenRef);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
