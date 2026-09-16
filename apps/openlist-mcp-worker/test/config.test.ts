import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("OpenList config", () => {
  it("defaults OPENLIST_ALLOWED_PATHS to root when omitted", () => {
    const config = loadConfig({
      OPENLIST_URL: "https://openlist.example.com",
      OPENLIST_TOKEN: "token",
    });

    expect(config.allowedPaths).toEqual(["/"]);
  });

  it("defaults OPENLIST_ALLOWED_PATHS to root when blank", () => {
    const config = loadConfig({
      OPENLIST_URL: "https://openlist.example.com",
      OPENLIST_TOKEN: "token",
      OPENLIST_ALLOWED_PATHS: "   ",
    });

    expect(config.allowedPaths).toEqual(["/"]);
  });

  it("preserves an explicit comma-separated allowlist", () => {
    const config = loadConfig({
      OPENLIST_URL: "https://openlist.example.com",
      OPENLIST_TOKEN: "token",
      OPENLIST_ALLOWED_PATHS: "/documents, /backup",
    });

    expect(config.allowedPaths).toEqual(["/documents", "/backup"]);
  });
});
