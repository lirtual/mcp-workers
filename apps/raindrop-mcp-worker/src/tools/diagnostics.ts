import { z } from "zod";
import pkg from "../../package.json";
import type { ToolHandlerContext } from "./common.js";
import { defineTool } from "./common.js";

export const DiagnosticsInputSchema = z.object({
  includeEnvironment: z
    .boolean()
    .optional()
    .describe(
      "Deprecated compatibility flag. Worker diagnostics never expose environment variables or credentials.",
    ),
});

export const DiagnosticsOutputSchema = z.object({
  version: z.string(),
  mcpProtocolVersion: z.string(),
  sdkVersion: z.string(),
  runtime: z.literal("cloudflare-workers"),
  httpMode: z.literal("per-request"),
  enabledTools: z.array(z.string()),
  libraryHealth: z.record(z.string(), z.number()).optional(),
});

export const createDiagnosticsTool = (
  serverVersion: string,
  getEnabledToolNames: () => string[],
) =>
  defineTool({
    name: "diagnostics",
    description:
      "Worker-safe server diagnostics, tool metadata, and Raindrop library health.",
    inputSchema: DiagnosticsInputSchema,
    outputSchema: DiagnosticsOutputSchema,
    handler: async (
      _args?: z.infer<typeof DiagnosticsInputSchema>,
      context?: ToolHandlerContext,
    ) => {
      const stats = context?.raindropService
        ? await context.raindropService.getUserStats()
        : null;

      let healthDetails: Record<string, number> = {};
      if (context?.raindropService) {
        const [broken, duplicates, untagged] = await Promise.all([
          context.raindropService.getBookmarks({ broken: true, perPage: 1 }),
          context.raindropService.getBookmarks({
            duplicates: true,
            perPage: 1,
          }),
          context.raindropService.getBookmarks({ notag: true, perPage: 1 }),
        ]);
        healthDetails = {
          brokenCount: broken.count,
          duplicateCount: duplicates.count,
          untaggedCount: untagged.count,
        };
      }

      const diagnosticsData = {
        version: serverVersion,
        mcpProtocolVersion: "2026-07-28",
        sdkVersion: pkg.dependencies["@modelcontextprotocol/server"],
        runtime: "cloudflare-workers" as const,
        httpMode: "per-request" as const,
        libraryHealth: stats
          ? {
              totalBookmarks: stats.bookmarks,
              totalCollections: stats.collections,
              totalHighlights: stats.highlights,
              totalTags: stats.tags,
              ...healthDetails,
            }
          : undefined,
        enabledTools: getEnabledToolNames(),
      };

      const structuredContent = DiagnosticsOutputSchema.parse(diagnosticsData);

      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: "diagnostics://server",
              mimeType: "application/json",
              text: JSON.stringify(structuredContent, null, 2),
            },
          },
        ],
        structuredContent,
      };
    },
  });
