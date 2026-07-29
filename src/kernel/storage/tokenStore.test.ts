import { describe, expect, it, vi } from "vitest";
import { createTauriTokenStore, type TauriInvoke } from "./tokenStore";

describe("Tauri token store", () => {
  it("maps get, set, and delete to the intentionally small native command surface", async () => {
    const invoke = vi.fn(async (command: string) => command === "token_get" ? "saved-token" : null);
    // The real `invoke` is generic; a mock with a concrete return type cannot
    // satisfy that signature directly.
    const store = createTauriTokenStore(invoke as unknown as TauriInvoke);

    await expect(store.get("server-ref")).resolves.toBe("saved-token");
    await store.set("server-ref", "new-token");
    await store.delete("server-ref");

    expect(invoke).toHaveBeenNthCalledWith(1, "token_get", { tokenRef: "server-ref" });
    expect(invoke).toHaveBeenNthCalledWith(2, "token_set", { tokenRef: "server-ref", token: "new-token" });
    expect(invoke).toHaveBeenNthCalledWith(3, "token_delete", { tokenRef: "server-ref" });
  });

  it("normalizes a missing native credential to undefined", async () => {
    const store = createTauriTokenStore(vi.fn(async () => null) as unknown as TauriInvoke);
    await expect(store.get("missing")).resolves.toBeUndefined();
  });
});
