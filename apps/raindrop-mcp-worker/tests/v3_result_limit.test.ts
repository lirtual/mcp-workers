import { describe, expect, it } from "vitest";
import { EXECUTION_LIMITS } from "../src/services/execution-budget.js";
import { toolSuccess } from "../src/tools/common.js";

describe("T08: result size must not rewrite acknowledged write outcomes", () => {
  const oversized = "x".repeat(EXECUTION_LIMITS.resultBytes);

  it.each(["succeeded", "partial"] as const)(
    "preserves %s write and its scope when result data exceeds 2 MiB",
    (status) => {
      const result = toolSuccess(
        { item: { note: oversized } },
        { status, requestedIds: [17], modified: status === "partial" ? 0 : 1,
          requestCount: 1, scope: { collectionId: 4 } },
        "Write accepted",
      );
      expect(result).not.toHaveProperty("isError", true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: null,
        meta: {
          status, outputOmitted: true, requestedIds: [17],
          modified: status === "partial" ? 0 : 1,
          scope: { collectionId: 4 }, requestCount: 1,
        },
      });
      expect(result.structuredContent.meta.warnings).toContain(
        "Result data exceeds 2 MiB; read the target for details",
      );
      expect(JSON.stringify(result).length).toBeLessThan(1024);
    },
  );

  it("rejects an oversized read instead of silently dropping note/highlights", () => {
    const result = toolSuccess({ item: { note: oversized } }, { requestCount: 1 }, "Read");
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "RESPONSE_TOO_LARGE" },
        meta: { requestCount: 1 },
      },
    });
    expect(JSON.stringify(result).length).toBeLessThan(1024);
  });

  it("preserves existing warnings without duplicating large data", () => {
    const result = toolSuccess(
      { item: { note: oversized } },
      { status: "succeeded", warnings: ["Target effect unverified"], requestCount: 1 },
    );
    expect(result.structuredContent.meta.warnings).toEqual([
      "Target effect unverified",
      "Result data exceeds 2 MiB; read the target for details",
    ]);
  });
});
