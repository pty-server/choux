import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, serverApiConfig } from "./api";

const { nativeRequest } = vi.hoisted(() => ({ nativeRequest: vi.fn() }));

vi.mock("./nativeTransport", () => ({ nativeRequest }));

function respondWith(body: unknown) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const legacyWorkspace = { id: "w1", path: "/src/shop/", realpath: "/src/shop", createdAt: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
  nativeRequest.mockReset();
});

describe("createApiClient workspaces", () => {
  it("normalises listed workspaces from servers that predate kinds and names", async () => {
    respondWith([legacyWorkspace]);
    const client = createApiClient({ baseUrl: "http://server.test", token: "t" });

    await expect(client.getWorkspaces()).resolves.toEqual([{ ...legacyWorkspace, kind: "project", name: "shop" }]);
  });

  it("normalises a created workspace and sends the request body as given", async () => {
    const fetch = respondWith(legacyWorkspace);
    const client = createApiClient({ baseUrl: "http://server.test", token: "t" });

    await expect(client.createWorkspace({ path: "/src/shop", kind: "runner", name: "stack" }))
      .resolves.toEqual({ ...legacyWorkspace, kind: "project", name: "shop" });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ path: "/src/shop", kind: "runner", name: "stack" });
  });

  it("deletes a workspace by its encoded id and accepts an empty response", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const client = createApiClient({ baseUrl: "http://server.test", token: "t" });

    await client.deleteWorkspace("w 1");

    expect(fetch.mock.calls[0][0]).toBe("http://server.test/v1/workspaces/w%201");
    expect(fetch.mock.calls[0][1].method).toBe("DELETE");
  });

  it("surfaces the server's refusal to delete a workspace with running sessions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: "workspace has running sessions" }), { status: 409 })));
    const client = createApiClient({ baseUrl: "http://server.test", token: "t" });

    await expect(client.deleteWorkspace("w1")).rejects.toMatchObject({ status: 409, message: "workspace has running sessions" });
  });

  it("scopes a directory listing to a workspace", async () => {
    const fetch = respondWith({ breadcrumbs: [], entries: [] });
    const client = createApiClient({ baseUrl: "http://server.test", token: "t" });

    await client.listDirectories(undefined, undefined, undefined, "w 1");

    expect(fetch.mock.calls[0][0]).toBe("http://server.test/v1/directories?workspaceId=w+1");
  });
});

describe("createApiClient session control", () => {
  it("signals a session and accepts an empty response", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const client = createApiClient({ baseUrl: "http://server.test", token: "t" });

    await client.signalSession("s 1", "SIGKILL");

    expect(fetch.mock.calls[0][0]).toBe("http://server.test/v1/sessions/s%201/signal");
    expect(fetch.mock.calls[0][1].method).toBe("POST");
    expect(fetch.mock.calls[0][1].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ signal: "SIGKILL" });
  });

  it("moves a session by patching only its workspace", async () => {
    const fetch = respondWith({ id: "s 1", workspaceId: "w 2" });
    const client = createApiClient({ baseUrl: "http://server.test", token: "t" });

    await expect(client.moveSession("s 1", "w 2")).resolves.toMatchObject({ workspaceId: "w 2" });

    expect(fetch.mock.calls[0][0]).toBe("http://server.test/v1/sessions/s%201");
    expect(fetch.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ workspaceId: "w 2" });
  });
});

describe("createApiClient native transport", () => {
  const ssh = { kind: "ssh", host: "box", instance: "default" } as const;

  it("selects the native transport from a server's config and never fetches", async () => {
    const fetch = respondWith([]);
    nativeRequest.mockResolvedValue({ status: 200, statusText: "OK", body: "[]" });
    const client = createApiClient(serverApiConfig({ url: "http://default.ptys.local", transport: ssh }, undefined));

    await expect(client.getSessions()).resolves.toEqual([]);

    expect(nativeRequest).toHaveBeenCalledWith(ssh, "/v1/sessions", { headers: {} });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a long-running exec off the shared connection", async () => {
    nativeRequest.mockResolvedValue({ status: 200, statusText: "OK", body: "{\"code\":0}" });
    const client = createApiClient({ baseUrl: "http://default.ptys.local", native: ssh });

    await client.execSession("s1", { cmd: "sleep", args: ["2"] });

    expect(nativeRequest.mock.calls[0][2]).toMatchObject({ method: "POST", lane: "dedicated" });
  });

  it("uses HTTP for a server without a transport", () => {
    expect(serverApiConfig({ url: "http://server.test" }, "t")).toEqual({ baseUrl: "http://server.test", token: "t" });
  });
});
