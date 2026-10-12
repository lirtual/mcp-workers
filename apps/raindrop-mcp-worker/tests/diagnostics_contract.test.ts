import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsTool,
  DiagnosticsOutputSchema,
} from "../src/tools/diagnostics.js";
import type { ToolHandlerContext } from "../src/tools/common.js";

describe("Worker-native diagnostics contract", () => {
  it("keeps operational metadata while excluding Node/Bun/environment details", async () => {
    const getBookmarks = vi.fn(async (query: Record<string, unknown>) => {
      if (query.broken) return { count: 1 };
      if (query.duplicates) return { count: 2 };
      if (query.notag) return { count: 3 };
      return { count: 0 };
    });

    const context = {
      raindropService: {
        getUserStats: vi.fn(async () => ({
          bookmarks: 10,
          collections: 4,
          highlights: 2,
          tags: 7,
        })),
        getBookmarks,
      },
    } as unknown as ToolHandlerContext;

    const tool = createDiagnosticsTool("2.4.5", () => [
      "diagnostics",
      "collection_list",
    ]);
    const result = await tool.handler({ includeEnvironment: true }, context);
    const structured = DiagnosticsOutputSchema.parse(
      (result as { structuredContent: unknown }).structuredContent,
    );

    expect(tool.name).toBe("diagnostics");
    expect(structured).toMatchObject({
      version: "2.4.5",
      mcpProtocolVersion: "2026-07-28",
      runtime: "cloudflare-workers",
      httpMode: "per-request",
      enabledTools: ["diagnostics", "collection_list"],
      libraryHealth: {
        totalBookmarks: 10,
        totalCollections: 4,
        totalHighlights: 2,
        totalTags: 7,
        brokenCount: 1,
        duplicateCount: 2,
        untaggedCount: 3,
      },
    });

    const content = (result as { content: Array<{ resource?: { text?: string } }> })
      .content[0];
    const resourcePayload = JSON.parse(content?.resource?.text ?? "{}");

    for (const obsoleteField of [
      "nodeVersion",
      "bunVersion",
      "os",
      "uptime",
      "startTime",
      "env",
      "memory",
    ]) {
      expect(resourcePayload).not.toHaveProperty(obsoleteField);
    }
    expect(JSON.stringify(resourcePayload)).not.toContain("RAINDROP_ACCESS_TOKEN");
  });
});
