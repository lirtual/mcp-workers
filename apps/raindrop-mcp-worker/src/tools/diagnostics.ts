import { z } from "zod";
import type { ToolHandlerContext } from "./common.js";
import { defineTool, ToolEnvelopeSchema, toolSuccess } from "./common.js";

export const DiagnosticsInputSchema = z.object({
  includeUpstream: z.boolean().default(false),
}).strict();

export const DiagnosticsOutputSchema = ToolEnvelopeSchema;

export const createDiagnosticsTool = (
  serverVersion: string,
  getEnabledToolNames: () => string[],
) =>
  defineTool({
    name: "diagnostics",
    description: "Local Worker metadata; optionally read official Raindrop user statistics.",
    inputSchema: DiagnosticsInputSchema,
    outputSchema: DiagnosticsOutputSchema,
    annotations: { readOnlyHint: true },
    handler: async (
      args: z.infer<typeof DiagnosticsInputSchema>,
      context: ToolHandlerContext,
    ) => {
      // Do not inspect runtime environment, sample client models, or infer any
      // upstream count by performing a potentially unbounded library scan.
      const stats = args.includeUpstream
        ? await context.raindropService.getUserStats()
        : null;
      const data = {
        version: serverVersion,
        protocolVersion: null, // The negotiated version is not exposed here.
        runtime: "cloudflare-workers",
        httpMode: "per-request",
        enabledTools: getEnabledToolNames(),
        libraryHealth: stats
          ? {
              totalBookmarks: stats.bookmarks ?? null,
              totalCollections: stats.collections ?? null,
              totalHighlights: stats.highlights ?? null,
              totalTags: stats.tags ?? null,
            }
          : null,
      };
      return toolSuccess(
        data,
        { requestCount: context.raindropService.budget.requestCount },
        "Diagnostics collected",
      );
    },
  });
