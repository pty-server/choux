import { openDatabase, tokensStoreName } from "./db";

export interface TokenStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, token: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** True only inside the native Tauri webview; browser builds retain IndexedDB. */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createIndexedDbTokenStore(): TokenStore {
  return {
    async get(ref: string): Promise<string | undefined> {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const request = db.transaction(tokensStoreName).objectStore(tokensStoreName).get(ref);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },

    async set(ref: string, token: string): Promise<void> {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const request = db.transaction(tokensStoreName, "readwrite").objectStore(tokensStoreName).put(token, ref);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },

    async delete(ref: string): Promise<void> {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const request = db.transaction(tokensStoreName, "readwrite").objectStore(tokensStoreName).delete(ref);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
  };
}

/**
 * The native shell exposes this deliberately tiny command surface. Keeping it
 * behind TokenStore means all existing server/session call sites remain target
 * agnostic and raw tokens never enter IndexedDB under Tauri.
 */
export function createTauriTokenStore(invoke: TauriInvoke): TokenStore {
  return {
    async get(ref: string): Promise<string | undefined> {
      return (await invoke<string | null>("token_get", { tokenRef: ref })) ?? undefined;
    },
    async set(ref: string, token: string): Promise<void> {
      await invoke("token_set", { tokenRef: ref, token });
    },
    async delete(ref: string): Promise<void> {
      await invoke("token_delete", { tokenRef: ref });
    },
  };
}

// Export a live binding: modules that import tokenStore automatically see the
// native implementation after initialization, without changing call sites.
export let tokenStore: TokenStore = createIndexedDbTokenStore();

export async function initializeTokenStore(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  tokenStore = createTauriTokenStore(invoke);
}
