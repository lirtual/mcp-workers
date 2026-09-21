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
  includeUpstream: z
    .boolean()
    .optional()
    .describe(
      "When true, fetch current Raindrop library statistics. Default diagnostics make no upstream calls.",
    ),
});

export const DiagnosticsOutputSchema = z.object({
  version: z.string(),
  protocolTarget: z.string(),
  sdkVersion: z.string(),
  runtime: z.literal("cloudflare-workers"),
  httpMode: z.literal("per-request"),
  enabledTools: z.array(z.string()),
  libraryHealth: z.record(z.string(), z.number().nullable()).nullable(),
});

export const createDiagnosticsTool = (
  serverVersion: string,
  getEnabledToolNames: () => string[],
) =>
  defineTool({
    name: "diagnostics",
    description:
      "Diagnostics for the Worker server, tool metadata, and Raindrop library health.",
    inputSchema: DiagnosticsInputSchema,
    outputSchema: DiagnosticsOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    handler: async (
      args?: z.infer<typeof DiagnosticsInputSchema>,
      context?: ToolHandlerContext,
    ) => {
      const includeUpstream = args?.includeUpstream === true;
      let libraryHealth: Record<string, number | null> | null = null;
      if (includeUpstream && context?.raindropService) {
        const stats = await context.raindropService.getUserStats();
        const [broken, duplicates, untagged] = await Promise.all([
          context.raindropService.getBookmarks({ broken: true, perPage: 1 }),
          context.raindropService.getBookmarks({
            duplicates: true,
            perPage: 1,
          }),
          context.raindropService.getBookmarks({ notag: true, perPage: 1 }),
        ]);
        libraryHealth = {
          totalBookmarks: stats?.bookmarks ?? null,
          totalCollections: stats?.collections ?? null,
          totalHighlights: stats?.highlights ?? null,
          totalTags: stats?.tags ?? null,
          brokenCount: broken.count ?? null,
          duplicateCount: duplicates.count ?? null,
          untaggedCount: untagged.count ?? null,
        };
      }

      const diagnosticsData = {
        version: serverVersion,
        protocolTarget: "2026-07-28",
        sdkVersion: pkg.dependencies["@modelcontextprotocol/server"],
        runtime: "cloudflare-workers" as const,
        httpMode: "per-request" as const,
        libraryHealth,
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
