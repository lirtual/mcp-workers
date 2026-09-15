import { asAppError } from "./errors";

export function ok(data: unknown) {
  const structured = data !== null && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : { value: data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

export function fail(error: unknown) {
  const appError = asAppError(error);
  const payload = { error: { code: appError.code, message: appError.message, details: appError.details } };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
