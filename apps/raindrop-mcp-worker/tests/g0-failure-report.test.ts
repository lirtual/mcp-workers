import { describe, expect, it } from "vitest";
import { raiseG0Failures } from "./g0-failure-report.js";

describe("G0 independent failure reporting", () => {
  it("does not signal failure when the action and cleanup succeed", () => {
    expect(() => raiseG0Failures(null, null)).not.toThrow();
  });

  it("keeps an original action failure visible", () => {
    const original = new Error("favorite exclusion mismatch");
    expect(() => raiseG0Failures({ error: original }, null)).toThrow(original);
  });

  it("reports a cleanup-only failure", () => {
    const cleanup = new Error("disposable collection not verified");
    expect(() => raiseG0Failures(null, { error: cleanup })).toThrow(cleanup);
  });

  it("preserves both independent failures without masking either", () => {
    const original = new Error("favorite exclusion mismatch");
    const cleanup = new Error("disposable collection not verified");
    try {
      raiseG0Failures({ error: original }, { error: cleanup });
      throw new Error("Missing expected AggregateError");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([original, cleanup]);
      expect((error as Error).message).toContain(original.message);
      expect((error as Error).message).toContain(cleanup.message);
    }
  });

  it("preserves falsy thrown values instead of treating them as success", () => {
    expect(() => raiseG0Failures({ error: 0 }, { error: false }))
      .toThrow(AggregateError);
    expect(() => raiseG0Failures({ error: 0 }, null)).toThrow();
  });
});
