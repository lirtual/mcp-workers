import { z } from "zod";
import type { ToolHandlerContext } from "./common.js";
import { defineTool, ToolEnvelopeSchema } from "./common.js";
import { createDiagnosticsTool } from "./diagnostics.js";
import { raindropV3ListInputSchema, raindropV3ListTool } from "./raindrop-v3.js";

const diagnosticsLocalSchema = z.object({
  action: z.literal("local"),
}).strict();

// Preserve every v3 list default, filter, validation rule, and refinement.
// Only the v4 action discriminant is new; unknown fields stay forbidden.
const raindropListSchema = raindropV3ListInputSchema.safeExtend({
  action: z.literal("list"),
});

export const createV4ReadTracerTools = (
  serverVersion: string,
  getEnabledToolNames: () => string[],
) => {
  const diagnosticsV3 = createDiagnosticsTool(serverVersion, getEnabledToolNames);
  return [
    defineTool({
      name: "diagnostics_read",
      description: "Read local Worker diagnostics without contacting Raindrop.io.",
      inputSchema: diagnosticsLocalSchema,
      outputSchema: ToolEnvelopeSchema,
      annotations: { readOnlyHint: true },
      handler: async (
        _args: z.infer<typeof diagnosticsLocalSchema>,
        context: ToolHandlerContext,
      ) => diagnosticsV3.handler({ includeUpstream: false }, context),
    }),
    defineTool({
      name: "raindrop_read",
      description: "Read one bounded page of Raindrop bookmark summaries (action=list).",
      inputSchema: raindropListSchema,
      outputSchema: ToolEnvelopeSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      handler: async (
        { action: _action, ...args }: z.infer<typeof raindropListSchema>,
        context: ToolHandlerContext,
      ) => raindropV3ListTool.handler(args, context),
    }),
  ];
};
