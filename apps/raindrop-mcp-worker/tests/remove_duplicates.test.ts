import { describe, expect, it } from "vitest";
import { cleanupTools } from "../src/tools/cleanup.js";

describe("legacy remove_duplicates compatibility", () => {
  const tool = cleanupTools.find((t) => t.name === "remove_duplicates")!;
  it("keeps the legacy shape but rejects execution before any service call", async () => {
    const ctx = {
      raindropService: new Proxy(
        {},
        {
          get: () => {
            throw new Error("Service must not be accessed");
          },
        },
      ),
    } as never;
    for (const args of [{}, { dryRun: true }, { skipCache: true }]) {
      const result = await tool.handler(args, ctx);
      expect(JSON.stringify(result)).toMatch(/preview/i);
      expect(JSON.stringify(result)).toContain("bookmark_remove_duplicates");
    }
    await expect(tool.handler({ dryRun: false }, ctx)).rejects.toThrow(
      /Legacy deletion disabled/,
    );
    for (const args of [
      { confirm: true },
      { unknown: true },
      { dryRun: "false" },
    ])
      expect(tool.inputSchema.safeParse(args).success).toBe(false);
  });
});
