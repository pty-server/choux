import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./api";

function respondWith(body: unknown) {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const legacyWorkspace = { id: "w1", path: "/src/shop/", realpath: "/src/shop", createdAt: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("scopes a directory listing to a workspace", async () => {
    const fetch = respondWith({ breadcrumbs: [], entries: [] });
    const client = createApiClient({ baseUrl: "http://server.test", token: "t" });

    await client.listDirectories(undefined, undefined, undefined, "w 1");

    expect(fetch.mock.calls[0][0]).toBe("http://server.test/v1/directories?workspaceId=w+1");
  });
});
