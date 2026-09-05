import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listen = vi.fn();
const invoke = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LocalPtysSocket teardown", () => {
  beforeEach(() => {
    Object.assign(globalThis, { window: { __TAURI_INTERNALS__: {} } });
    listen.mockReset();
    invoke.mockReset();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("drops the listener registered after an early close", async () => {
    const { localPtysSocket } = await import("./localPtys");
    const unlisten = vi.fn();
    const registration = deferred<() => void>();
    listen.mockReturnValue(registration.promise);

    const socket = localPtysSocket("default", "/v1/attach", []);
    await vi.waitFor(() => expect(listen).toHaveBeenCalled());
    socket.close();
    registration.resolve(unlisten);
    await flush();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("closes a native connection that opened after the close", async () => {
    const { localPtysSocket } = await import("./localPtys");
    listen.mockResolvedValue(vi.fn());
    const opening = deferred<string>();
    invoke.mockImplementation((command: string) => (
      command === "local_socket_open" ? opening.promise : Promise.resolve()
    ));

    const socket = localPtysSocket("default", "/v1/attach", []);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("local_socket_open", expect.anything()));
    socket.close();
    opening.resolve("local-7");
    await flush();

    expect(invoke).toHaveBeenCalledWith("local_socket_close", { connectionId: "local-7" });
  });
});
