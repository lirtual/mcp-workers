import { raindropV3Tools } from "./raindrop-v3.js";
import { raindropV3MutationTools } from "./raindrop-v3-mutations.js";
import { raindropV3TagTools } from "./raindrop-v3-tags.js";
import { raindropV3HighlightTools } from "./raindrop-v3-highlights.js";
import { raindropV3CollectionTools } from "./raindrop-v3-collections.js";
import { raindropV3CleanupTools } from "./raindrop-v3-cleanup.js";
import { raindropV3AuditTools } from "./raindrop-v3-audit.js";
import { createDiagnosticsTool } from "./diagnostics.js";
import type { ToolConfig } from "./common.js";
import { outputSchemaForTool } from "./output-contracts.js";

export type { ToolConfig, ToolHandlerContext, McpContent } from "./common.js";

export const buildToolConfigs = (options: { serverVersion: string }) => {
  let toolConfigs: ToolConfig<any, any>[] = [];
  const getEnabledToolNames = () => toolConfigs.map((tool) => tool.name);

  toolConfigs = [
    createDiagnosticsTool(options.serverVersion, getEnabledToolNames),
    ...raindropV3Tools,
    ...raindropV3MutationTools,
    ...raindropV3CollectionTools,
    ...raindropV3TagTools,
    ...raindropV3HighlightTools,
    ...raindropV3AuditTools,
    ...raindropV3CleanupTools,
  ];
  for (const config of toolConfigs) {
    config.outputSchema = outputSchemaForTool(config.name);
  }
  return { toolConfigs, getEnabledToolNames };
};
