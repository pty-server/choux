import { describe, expect, it } from "vitest";
import {
  connectionIdentity,
  defaultServerLabel,
  sameTransport,
  serverAddressKey,
  serverAddressProblem,
  serverAddressSummary,
  transportKind,
  transportProblem,
  validTransport,
  type ServerTransport,
} from "./serverTransport";

describe("transportProblem", () => {
  it.each<ServerTransport>([
    { kind: "local", instance: "default" },
    { kind: "local", instance: "work.dev_2" },
    { kind: "ssh", host: "box", instance: "default" },
    { kind: "ssh", host: "me@box.lan", instance: "work", nodeBin: "/home/me/.nvm/versions/node/v24.21.0/bin" },
    { kind: "ssh", host: "_svc@10.0.0.2", instance: "default" },
    { kind: "ssh", host: "fe80::1", instance: "default" },
    { kind: "ssh", host: "::1", instance: "default" },
    { kind: "ssh", host: "me@::1", instance: "default", nodeBin: "/opt/node/bin/" },
    { kind: "wsl", distro: "Ubuntu-24.04", user: "me", instance: "default" },
  ])("accepts %j", (transport) => {
    expect(transportProblem(transport)).toBeUndefined();
  });

  it.each([
    [{ kind: "local", instance: "" }, "instance name"],
    [{ kind: "local", instance: "-work" }, "instance name"],
    [{ kind: "local" }, "instance name"],
    [{ kind: "local", instance: "x".repeat(65) }, "instance name"],
    [{ kind: "ssh", host: "-oProxyCommand=evil", instance: "default" }, "SSH host"],
    [{ kind: "ssh", host: "box; rm -rf ~", instance: "default" }, "SSH host"],
    [{ kind: "ssh", host: "me@-box", instance: "default" }, "SSH host"],
    [{ kind: "ssh", host: "a@b@c", instance: "default" }, "SSH host"],
    [{ kind: "ssh", host: "box", instance: "default", nodeBin: "relative/bin" }, "node directory"],
    [{ kind: "ssh", host: "box", instance: "default", nodeBin: "/opt:/evil" }, "node directory"],
    [{ kind: "ssh", host: "box", instance: "default", nodeBin: "/opt/../etc" }, "node directory"],
    [{ kind: "wsl", distro: "-d", user: "me", instance: "default" }, "distribution"],
    [{ kind: "wsl", distro: "Debian", user: "-u", instance: "default" }, "user"],
    [{ kind: "wsl", distro: "Debian", user: "me", instance: "default", nodeBin: "/mnt/c/nodejs" }, "Windows drive"],
    [{ kind: "wsl", distro: "Debian", user: "me", instance: "default", nodeBin: "/./mnt/c/nodejs" }, "node directory"],
    [{ kind: "wsl", distro: "Debian", user: "me", instance: "default", nodeBin: "//mnt/c/nodejs" }, "node directory"],
    [{ kind: "ssh", host: "box", instance: "default", nodeBin: "/opt//node" }, "node directory"],
    [{ kind: "ssh", host: "box", instance: "default", nodeBin: "" }, "node directory"],
    [null, "Unknown connection type"],
    [{ kind: "tcp", instance: "default" }, "Unknown connection type"],
    ["local", "Unknown connection type"],
  ])("rejects %j", (transport, reason) => {
    expect(transportProblem(transport)).toContain(reason);
  });
});

describe("serverAddressProblem", () => {
  it("accepts an http or https URL without a transport", () => {
    expect(serverAddressProblem({ url: "http://127.0.0.1:7801" })).toBeUndefined();
    expect(serverAddressProblem({ url: "https://ptys.example.com/base" })).toBeUndefined();
  });

  it("rejects a URL a browser cannot request", () => {
    expect(serverAddressProblem({ url: "localhost:7801" })).toContain("http://");
    expect(serverAddressProblem({ url: "not a url" })).toContain("not a valid URL");
  });

  it("validates the transport instead of the placeholder URL", () => {
    expect(serverAddressProblem({ url: "http://default.ptys.local", transport: { kind: "ssh", host: "-x", instance: "default" } })).toContain("SSH host");
  });
});

describe("connectionIdentity", () => {
  it("keeps instances of one host apart and ignores the URL of a native transport", () => {
    const identities = [
      connectionIdentity({ url: "http://default.ptys.local", transport: { kind: "local", instance: "default" } }),
      connectionIdentity({ url: "http://default.ptys.local", transport: { kind: "local", instance: "work" } }),
      connectionIdentity({ url: "http://default.ptys.local", transport: { kind: "ssh", host: "box", instance: "default" } }),
      connectionIdentity({ url: "http://default.ptys.local", transport: { kind: "wsl", distro: "Debian", user: "me", instance: "default" } }),
      connectionIdentity({ url: "http://default.ptys.local", transport: { kind: "wsl", distro: "Ubuntu", user: "me", instance: "default" } }),
      connectionIdentity({ url: "http://default.ptys.local" }),
    ];

    expect(new Set(identities).size).toBe(identities.length);
  });

  it("treats URLs that differ only in path as one server", () => {
    expect(connectionIdentity({ url: "http://127.0.0.1:7801/ptys?x=1" })).toBe(connectionIdentity({ url: "http://127.0.0.1:7801" }));
  });
});

describe("sameTransport", () => {
  it("compares the node directory as well as the identity", () => {
    const ssh: ServerTransport = { kind: "ssh", host: "box", instance: "default" };

    expect(sameTransport(undefined, undefined)).toBe(true);
    expect(sameTransport(ssh, { ...ssh })).toBe(true);
    expect(sameTransport(ssh, { ...ssh, nodeBin: "/opt/node/bin" })).toBe(false);
    expect(sameTransport(ssh, undefined)).toBe(false);
  });

  it("tells an empty stored node directory from a missing one and ignores key order", () => {
    const ssh: ServerTransport = { kind: "ssh", host: "box", instance: "default" };

    expect(sameTransport({ ...ssh, nodeBin: "" }, ssh)).toBe(false);
    expect(sameTransport({ ...ssh, nodeBin: undefined }, ssh)).toBe(true);
    expect(sameTransport({ instance: "default", host: "box", kind: "ssh" }, ssh)).toBe(true);
    expect(sameTransport(null, undefined)).toBe(false);
  });

  it("keys a server by its full transport, or by its URL without one", () => {
    const ssh: ServerTransport = { kind: "ssh", host: "box", instance: "default" };

    expect(serverAddressKey({ url: "http://default.ptys.local", transport: ssh }))
      .not.toBe(serverAddressKey({ url: "http://default.ptys.local", transport: { ...ssh, nodeBin: "/opt/node/bin" } }));
    expect(serverAddressKey({ url: "http://one.test/x" })).toBe(serverAddressKey({ url: "http://one.test" }));
    expect(serverAddressKey({ url: "http://x.ptys.local", transport: null })).toBe("null");
  });
});

describe("reading stored transports", () => {
  it("names the kind of any object and accepts only valid transports", () => {
    expect(transportKind({ kind: "ssh" })).toBe("ssh");
    expect(transportKind(null)).toBeUndefined();
    expect(transportKind({ kind: 3 })).toBeUndefined();
    expect(validTransport({ kind: "ssh" })).toBeUndefined();
    expect(validTransport({ kind: "local", instance: "work" })).toEqual({ kind: "local", instance: "work" });
  });
});

describe("labels", () => {
  it("names a server after its endpoint", () => {
    expect(defaultServerLabel({ kind: "local", instance: "work" })).toBe("Local work");
    expect(defaultServerLabel({ kind: "ssh", host: "me@box", instance: "default" })).toBe("me@box");
    expect(defaultServerLabel({ kind: "ssh", host: "box", instance: "work" })).toBe("box work");
    expect(serverAddressSummary({ url: "http://default.ptys.local", transport: { kind: "ssh", host: "box", instance: "default" } })).toBe("ssh box, instance default");
    expect(serverAddressSummary({ url: "https://ptys.example.com" })).toBe("https://ptys.example.com");
  });
});
