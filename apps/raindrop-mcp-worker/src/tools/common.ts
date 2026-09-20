import { z } from "zod";
import RaindropService from "../services/raindrop.service.js";
import { EXECUTION_LIMITS } from "../services/execution-budget.js";

export interface ToolHandlerContext {
  raindropService: RaindropService;
  mcpServer: any;
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
    // Once the upstream has acknowledged a write, response serialization must
    // never make it look failed or unknown. Preserve the known write status
    // and scope while omitting only the oversized result data.
    if (meta.status === "succeeded" || meta.status === "partial") {
      const warnings = Array.isArray(meta.warnings) ? meta.warnings.filter(
        (warning): warning is string => typeof warning === "string",
      ) : [];
      return {
        content: shortText("Write accepted; result data exceeds 2 MiB and was omitted. Read the target for details."),
        structuredContent: {
          ok: true as const,
          data: null,
          meta: {
            ...meta,
            warnings: [...warnings, "Result data exceeds 2 MiB; read the target for details"],
            outputOmitted: true,
          },
        },
      };
    }
    return toolFailure("RESPONSE_TOO_LARGE", "Tool result exceeds 2 MiB", {
      ...meta,
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
