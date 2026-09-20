import { bookmarkTools } from "./bookmarks.js";
import { raindropV3Tools } from "./raindrop-v3.js";
import { raindropV3MutationTools } from "./raindrop-v3-mutations.js";
import { raindropV3TagTools } from "./tags-v3.js";
import { raindropV3TagTools } from "./raindrop-v3-tags.js";
import { raindropV3HighlightTools } from "./raindrop-v3-highlights.js";
import { bulkTools } from "./bulk.js";
import { cleanupTools } from "./cleanup.js";
import { collectionTools } from "./collections.js";
import { createDiagnosticsTool } from "./diagnostics.js";
import { highlightTools } from "./highlights.js";
import { suggestionTools } from "./suggestions.js";
import { tagTools } from "./tags.js";
import type { ToolConfig } from "./common.js";

export type { ToolConfig, ToolHandlerContext, McpContent } from "./common.js";

export const buildToolConfigs = (options: { serverVersion: string }) => {
  let toolConfigs: ToolConfig<any, any>[] = [];
  const getEnabledToolNames = () => toolConfigs.map((tool) => tool.name);

  const diagnosticsTool = createDiagnosticsTool(
    options.serverVersion,
    getEnabledToolNames,
  );

  toolConfigs = [
    diagnosticsTool,
    ...collectionTools,
    ...bookmarkTools,
    ...raindropV3Tools,
    ...raindropV3MutationTools,
    ...raindropV3TagTools,
    ...raindropV3TagTools,
    ...raindropV3HighlightTools,
    ...tagTools,
    ...highlightTools,
    ...bulkTools,
    ...cleanupTools,
    ...suggestionTools,
  ];

  return { toolConfigs, getEnabledToolNames };
};
