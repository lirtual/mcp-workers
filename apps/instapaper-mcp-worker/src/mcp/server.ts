import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { InstapaperClient } from "../instapaper/client.js";
import type { InstapaperCredentials } from "../instapaper/types.js";

function asText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function asError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected Instapaper error.";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function createServer(credentials: InstapaperCredentials) {
  const client = new InstapaperClient(credentials);
  const server = new McpServer({
    name: "instapaper-mcp-worker",
    version: "2.0.0",
  });

  server.registerTool(
    "list_bookmarks",
    {
      description: "List Instapaper bookmarks by folder or tag. Defaults to unread bookmarks.",
      inputSchema: {
        folder: z.string().optional().describe('\"unread\", \"archive\", \"starred\", or a folder ID'),
        tag: z.string().optional().describe("Tag name; ignored when folder is provided"),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ folder, tag, limit }) => {
      try {
        return asText(await client.listBookmarks({ folder, tag, limit }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "get_article_content",
    {
      description: "Retrieve Instapaper's processed text-view HTML for one bookmark.",
      inputSchema: { bookmark_id: z.number().int().positive() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ bookmark_id }) => {
      try {
        return asText({
          bookmark_id,
          format: "html",
          content: await client.getArticleContent(bookmark_id),
        });
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "add_bookmark",
    {
      description: "Save a URL to Instapaper.",
      inputSchema: {
        url: z.url(),
        title: z.string().optional(),
        description: z.string().optional(),
        folder_id: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ url, title, description, folder_id }) => {
      try {
        return asText(await client.addBookmark({ url, title, description, folderId: folder_id }));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "set_bookmark_starred",
    {
      description: "Star or unstar an Instapaper bookmark.",
      inputSchema: {
        bookmark_id: z.number().int().positive(),
        starred: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ bookmark_id, starred }) => {
      try {
        return asText(await client.setStarred(bookmark_id, starred));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "set_bookmark_archived",
    {
      description: "Archive or restore an Instapaper bookmark.",
      inputSchema: {
        bookmark_id: z.number().int().positive(),
        archived: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ bookmark_id, archived }) => {
      try {
        return asText(await client.setArchived(bookmark_id, archived));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "move_bookmark",
    {
      description: "Move a bookmark to a user-created Instapaper folder.",
      inputSchema: {
        bookmark_id: z.number().int().positive(),
        folder_id: z.number().int().positive(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ bookmark_id, folder_id }) => {
      try {
        return asText(await client.moveBookmark(bookmark_id, folder_id));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "delete_bookmark",
    {
      description: "Permanently delete a bookmark from Instapaper. This is not archive and cannot be undone.",
      inputSchema: { bookmark_id: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ bookmark_id }) => {
      try {
        await client.deleteBookmark(bookmark_id);
        return asText({ deleted: true, bookmark_id });
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "list_folders",
    {
      description: "List user-created Instapaper folders.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        return asText(await client.listFolders());
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "create_folder",
    {
      description: "Create a user folder in Instapaper.",
      inputSchema: { title: z.string().min(1).max(255) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ title }) => {
      try {
        return asText(await client.createFolder(title));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "list_highlights",
    {
      description: "List highlights saved for an Instapaper bookmark.",
      inputSchema: { bookmark_id: z.number().int().positive() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ bookmark_id }) => {
      try {
        return asText(await client.listHighlights(bookmark_id));
      } catch (error) {
        return asError(error);
      }
    },
  );

  server.registerTool(
    "add_highlight",
    {
      description: "Add a highlight to an Instapaper bookmark.",
      inputSchema: {
        bookmark_id: z.number().int().positive(),
        text: z.string().min(1),
        position: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ bookmark_id, text, position }) => {
      try {
        return asText(await client.addHighlight(bookmark_id, text, position));
      } catch (error) {
        return asError(error);
      }
    },
  );

  return server;
}
