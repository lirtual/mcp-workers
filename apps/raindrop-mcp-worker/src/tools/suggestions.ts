import { z } from "zod";
import type { ToolHandlerContext } from "./common.js";
import { defineTool, textContent } from "./common.js";

/**
 * Tool to suggest tags for a bookmark using AI sampling.
 */
const suggestTagsTool = defineTool({
  name: "suggest_tags",
  description:
    "Uses AI to suggest relevant tags based on bookmark metadata (title, URL, description).",
  inputSchema: z.object({
    url: z.string().url().describe("The URL of the bookmark"),
    title: z.string().describe("The title of the bookmark"),
    description: z.string().optional().describe("The description/excerpt"),
  }),
  handler: async (
    args: { url: string; title: string; description?: string },
    { mcpReq }: ToolHandlerContext,
  ) => {
    if (!mcpReq) {
      return {
        content: [
          textContent(
            "AI Sampling is not supported by the current client. Please provide tags manually.",
          ),
        ],
      };
    }

    try {
      const response = await mcpReq.requestSampling({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please suggest 3-6 relevant, concise tags for this bookmark:
              Title: ${args.title}
              URL: ${args.url}
              Description: ${args.description || "N/A"}
              
              Return only a comma-separated list of tags.`,
            },
          },
        ],
        systemPrompt:
          "You are a helpful assistant that categorizes bookmarks. Suggest relevant, professional tags.",
      });

      const tags =
        response.content.type === "text"
          ? response.content.text
          : JSON.stringify(response.content);

      return {
        content: [
          textContent(`AI Suggested Tags for "${args.title}":\n${tags}`),
        ],
      };
    } catch (err: any) {
      return {
        content: [textContent(`Failed to get tag suggestions: ${err.message}`)],
      };
    }
  },
});

export const suggestionTools = [suggestTagsTool];
