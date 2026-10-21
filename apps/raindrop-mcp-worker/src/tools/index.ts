import { bookmarkBatchTools } from "./bookmark-batch.js";
import { bookmarkTools } from "./bookmarks.js";
import { collectionTools } from "./collections.js";
import { highlightTools } from "./highlights.js";
import { tagTools } from "./tags.js";
import type { ToolConfig } from "./common.js";

export type { ToolConfig, ToolHandlerContext, McpContent } from "./common.js";

// Spec #145: publish only Agent-facing atomic operations. Keep internal
// implementations independent from MCP exposure and do not register legacy
// aliases, diagnostics, Sampling, or permanent Trash deletion.
const agentToolNames = new Set([
  "collection_list", "collection_get", "collection_create", "collection_update",
  "bookmark_search", "bookmark_get", "bookmark_exists", "bookmark_create",
  "bookmark_update", "bookmark_move", "bookmark_delete", "bookmark_filters_get",
  "tag_list", "highlight_list", "highlight_create", "highlight_update", "highlight_delete",
  "tag_rename", "tag_merge", "tag_delete", "bookmark_batch_update", "bookmark_batch_delete",
  "collection_delete", "collection_remove_empty",
]);

export const buildToolConfigs = (_options: { serverVersion: string }) => {
  const toolConfigs: ToolConfig<any, any>[] = [
    ...collectionTools,
    ...bookmarkTools,
    ...tagTools,
    ...highlightTools,
    ...bookmarkBatchTools,
  ].filter(tool => agentToolNames.has(tool.name));
  const getEnabledToolNames = () => toolConfigs.map(tool => tool.name);

  return { toolConfigs, getEnabledToolNames };
};
