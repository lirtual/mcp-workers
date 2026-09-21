export type WriteState =
  | "preview"
  | "succeeded"
  | "partial"
  | "failed"
  | "unknown"
  | "not_executed";

export interface ResultMeta {
  attempts?: number;
  retryAfterMs?: number | null;
  truncated?: boolean;
  [key: string]: unknown;
}

export function okResult<T>(data: T, meta: ResultMeta = {}) {
  return {
    ok: true as const,
    data,
    meta,
  };
}

export function errorResult(
  error: { code: string; message: string; state?: WriteState },
  meta: ResultMeta = {},
) {
  return {
    ok: false as const,
    error,
    meta,
  };
}

export function mcpStructuredFromUnknownWrite(
  error: { message: string; retryAfterMs?: number },
  meta: ResultMeta = {},
) {
  const retryAfterMs = error.retryAfterMs;
  return {
    content: [{ type: "text" as const, text: error.message }],
    structuredContent: errorResult(
      { code: "UNKNOWN_WRITE", message: error.message, state: "unknown" },
      { ...meta, retryAfterMs: retryAfterMs ?? null },
    ),
    isError: true as const,
  };
}
