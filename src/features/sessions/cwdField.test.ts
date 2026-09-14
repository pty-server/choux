import { describe, expect, it } from "vitest";
import { cwdFieldValue } from "./cwdField";

describe("cwdFieldValue", () => {
  it("clears the field for the workspace root itself", () => {
    expect(cwdFieldValue("/src/shop", "/src/shop")).toBe("");
    expect(cwdFieldValue("/src/shop/", "/src/shop")).toBe("");
  });

  it("makes a directory below the root relative", () => {
    expect(cwdFieldValue("/src/shop/packages/web", "/src/shop")).toBe("packages/web");
    expect(cwdFieldValue("/src/shop/..cache", "/src/shop/")).toBe("..cache");
  });

  it("keeps a sibling that only shares a name prefix absolute", () => {
    expect(cwdFieldValue("/src/shop-admin", "/src/shop")).toBe("/src/shop-admin");
  });

  it("keeps a directory outside the root absolute", () => {
    expect(cwdFieldValue("/tmp/scratch", "/src/shop")).toBe("/tmp/scratch");
    expect(cwdFieldValue("/", "/home/user")).toBe("/");
  });

  it("treats everything as below a filesystem root", () => {
    expect(cwdFieldValue("/", "/")).toBe("");
    expect(cwdFieldValue("/home/user", "/")).toBe("home/user");
  });

  it("handles backslash separators", () => {
    expect(cwdFieldValue("C:\\src\\shop\\web", "C:\\src\\shop")).toBe("web");
  });
});
