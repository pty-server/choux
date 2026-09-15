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

const ssh = { kind: "ssh", host: "box", instance: "default" } as const;

beforeEach(() => {
  Object.assign(globalThis, { window: { __TAURI_INTERNALS__: {} } });
  listen.mockReset();
  invoke.mockReset();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("nativeRequest", () => {
  it("sends the typed target, never an argv, with the requested lane", async () => {
    const { nativeRequest } = await import("./nativeTransport");
    invoke.mockResolvedValue({ status: 200, statusText: "OK", body: "{}" });
    const target = new Proxy({ ...ssh }, {});

    await nativeRequest(target, "/v1/sessions/s1/exec", { method: "POST", body: "{}", lane: "dedicated" });

    expect(invoke).toHaveBeenCalledWith("ptys_request", {
      target: ssh,
      path: "/v1/sessions/s1/exec",
      method: "POST",
      headers: undefined,
      body: "{}",
      lane: "dedicated",
    });
    expect(invoke.mock.calls[0][1].target).not.toBe(target);
  });

  it("retains and releases a transport only in the desktop app", async () => {
    const { releaseNativeTransport, retainNativeTransport } = await import("./nativeTransport");
    await retainNativeTransport(ssh);
    await releaseNativeTransport(ssh);
    expect(invoke.mock.calls).toEqual([
      ["ptys_transport_retain", { target: ssh }],
      ["ptys_transport_release", { target: ssh }],
    ]);

    delete (globalThis as { window?: unknown }).window;
    invoke.mockReset();
    await retainNativeTransport(ssh);
    await releaseNativeTransport(ssh);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("NativeSocket teardown", () => {
  it("opens the socket at the path of the requested URL", async () => {
    const { nativeSocketFactory } = await import("./nativeTransport");
    listen.mockResolvedValue(vi.fn());
    invoke.mockResolvedValue("socket-1");

    nativeSocketFactory(ssh)("ws://default.ptys.local/v1/sessions/s1/attach?lossy=1", ["ptys.v1"]);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    expect(invoke).toHaveBeenCalledWith("ptys_socket_open", {
      target: ssh,
      path: "/v1/sessions/s1/attach?lossy=1",
      protocols: ["ptys.v1"],
      channel: expect.stringMatching(/^ptys-native-/),
    });
  });

  it("drops the listener registered after an early close", async () => {
    const { NativeSocket } = await import("./nativeTransport");
    const unlisten = vi.fn();
    const registration = deferred<() => void>();
    listen.mockReturnValue(registration.promise);

    const socket = new NativeSocket(ssh, "/v1/attach", []);
    await vi.waitFor(() => expect(listen).toHaveBeenCalled());
    socket.close();
    registration.resolve(unlisten);
    await flush();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("closes a native connection that opened after the close", async () => {
    const { NativeSocket } = await import("./nativeTransport");
    listen.mockResolvedValue(vi.fn());
    const opening = deferred<string>();
    invoke.mockImplementation((command: string) => (
      command === "ptys_socket_open" ? opening.promise : Promise.resolve()
    ));

    const socket = new NativeSocket(ssh, "/v1/attach", []);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("ptys_socket_open", expect.anything()));
    socket.close();
    opening.resolve("socket-7");
    await flush();

    expect(invoke).toHaveBeenCalledWith("ptys_socket_close", { connectionId: "socket-7" });
  });
});
