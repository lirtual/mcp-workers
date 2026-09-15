import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/utils/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Worker-native logger", () => {
  it("uses console output without Node process logging primitives", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = createLogger("test");

    logger.debug("hidden");
    logger.info("visible");

    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]?.[0])).toContain("[test] visible");
  });

  it("supports explicit log-level changes without ambient environment state", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = createLogger("test");

    logger.setLevel("debug");
    logger.debug("enabled");

    expect(logger.getLevel()).toBe("debug");
    expect(debug).toHaveBeenCalledOnce();
  });

  it("redacts bearer credentials and sensitive object fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = createLogger("security");

    logger.info("Authorization: Bearer portal-secret-123", {
      RAINDROP_ACCESS_TOKEN: "raindrop-secret-456",
      nested: {
        password: "password-secret-789",
        safe: "visible-value",
      },
      note: "token=inline-secret-000",
    });

    const output = info.mock.calls.flat().map(String).join(" ");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("visible-value");
    expect(output).not.toContain("portal-secret-123");
    expect(output).not.toContain("raindrop-secret-456");
    expect(output).not.toContain("password-secret-789");
    expect(output).not.toContain("inline-secret-000");
  });
});
