import { z } from "zod";
import RaindropService from "../services/raindrop.service.js";
import { EXECUTION_LIMITS } from "../services/execution-budget.js";

export interface ToolHandlerContext {
  raindropService: RaindropService;
  mcpServer: any;
  mcpReq?: {
    requestSampling: (params: any) => Promise<any>;
    elicitInput: (params: any) => Promise<any>;
    log: (level: string, message: string, logger?: string) => Promise<void>;
  };
  reportProgress?: (progress: { progress: number; total: number }) => void;
  [key: string]: unknown;
}

export interface ToolConfig<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  handler: (args: I, context: ToolHandlerContext) => Promise<O>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execution?: {
    taskSupport?: "supported" | "forbidden";
  };
}

export type McpContent =
  | { type: "text"; text: string; _meta?: Record<string, unknown> }
  | {
      type: "resource";
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
      };
    };

export const defineTool = <I, O>(config: ToolConfig<I, O>) => config;

export const textContent = (text: string): McpContent => ({
  type: "text",
  text,
});

export const makeCollectionLink = (collection: any): McpContent => ({
  type: "resource",
  resource: {
    uri: `mcp://collection/${collection._id}`,
    mimeType: "application/json",
    text: JSON.stringify(
      {
        _id: collection._id,
        title: collection.title || "Untitled Collection",
        count: collection.count || 0,
        description: collection.description,
      },
      null,
      2,
    ),
  },
});

export const makeBookmarkLink = (bookmark: any): McpContent => ({
  type: "resource",
  resource: {
    uri: `mcp://raindrop/${bookmark._id}`,
    mimeType: "application/json",
    text: JSON.stringify(
      {
        _id: bookmark._id,
        title: bookmark.title || "Untitled",
        link: bookmark.link,
        excerpt: bookmark.excerpt,
        tags: bookmark.tags,
      },
      null,
      2,
    ),
  },
});

export const setIfDefined = (
  target: Record<string, unknown>,
  key: string,
  value: unknown,
) => {
  if (value !== undefined) {
    target[key] = value;
  }
  return target;
};


export type WriteStatus =
  | "preview"
  | "succeeded"
  | "partial"
  | "failed"
  | "unknown"
  | "not_executed";

export const ToolEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    upstreamStatus: z.number().optional(),
    retryAfterMs: z.number().optional(),
  }).optional(),
  meta: z.record(z.string(), z.unknown()),
});

const shortText = (message: string) => [{ type: "text" as const, text: message }];

export function toolSuccess(
  data: unknown,
  meta: Record<string, unknown> = {},
  message = "Operation completed",
) {
  const structuredContent = { ok: true, data, meta };
  if (new TextEncoder().encode(JSON.stringify(structuredContent)).byteLength >
      EXECUTION_LIMITS.resultBytes) {
    return toolFailure("RESPONSE_TOO_LARGE", "Tool result exceeds 2 MiB", {
      ...meta,
      status: meta.status === "succeeded" ? "succeeded" : meta.status,
    });
  }
  return { content: shortText(message), structuredContent };
}

export function toolFailure(
  code: string,
  message: string,
  meta: Record<string, unknown> = {},
  extras: { upstreamStatus?: number; retryAfterMs?: number } = {},
) {
  return {
    isError: true as const,
    content: shortText(message),
    structuredContent: { ok: false as const, error: { code, message, ...extras }, meta },
  };
}
