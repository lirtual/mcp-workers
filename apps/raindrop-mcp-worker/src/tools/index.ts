import { bookmarkTools } from "./bookmarks.js";
import { raindropV3Tools } from "./raindrop-v3.js";
import { raindropV3MutationTools } from "./raindrop-v3-mutations.js";
import { raindropV3TagTools } from "./raindrop-v3-tags.js";
import { raindropV3HighlightTools } from "./raindrop-v3-highlights.js";
import { raindropV3CollectionTools } from "./raindrop-v3-collections.js";
import { raindropV3CleanupTools } from "./raindrop-v3-cleanup.js";
import { raindropV3AuditTools } from "./raindrop-v3-audit.js";
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
    // During migration, v3 collection_list replaces the legacy tool of the same name.
    ...collectionTools.filter((tool) => tool.name !== "collection_list"),
    ...bookmarkTools,
    ...raindropV3Tools,
    ...raindropV3MutationTools,
    ...raindropV3TagTools,
    ...raindropV3HighlightTools,
    ...raindropV3CollectionTools,
    ...raindropV3CleanupTools,
    ...raindropV3AuditTools,
    ...tagTools,
    ...highlightTools,
    ...bulkTools,
    ...cleanupTools.filter((tool) => tool.name !== "library_audit"),
    ...suggestionTools,
  ];

  return { toolConfigs, getEnabledToolNames };
};
