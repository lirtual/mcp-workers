import { describe, expect, it } from "vitest";
import { assertName, assertPathAllowed, isPathAllowed, normalizeOpenListPath } from "../src/policy/paths";

describe("path policy", () => {
  it("normalizes repeated separators and dots", () => {
    expect(normalizeOpenListPath("/docs//./work")).toBe("/docs/work");
  });

  it("rejects traversal including encoded traversal", () => {
    expect(() => normalizeOpenListPath("/docs/../private")).toThrow();
    expect(() => normalizeOpenListPath("/docs/%2e%2e/private")).toThrow();
  });

  it("matches on path boundaries", () => {
    expect(isPathAllowed("/documents/work", ["/documents"])).toBe(true);
    expect(isPathAllowed("/documents-old", ["/documents"])).toBe(false);
  });

  it("returns normalized allowed paths", () => {
    expect(assertPathAllowed("/documents//work", ["/documents"])).toBe("/documents/work");
  });

  it("rejects path-like names", () => {
    expect(() => assertName("../x")).toThrow();
    expect(() => assertName("a/b")).toThrow();
  });
});
