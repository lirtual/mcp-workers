export type ErrorCode =
  | "INVALID_ARGUMENT" | "UNAUTHENTICATED" | "PATH_FORBIDDEN" | "READONLY" | "NOT_FOUND"
  | "CONFLICT" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED" | "UPSTREAM_AUTH_FAILED"
  | "UPSTREAM_TIMEOUT" | "UPSTREAM_UNAVAILABLE" | "OPENLIST_ERROR";

export class AppError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    const prefix = error.message.split(":", 1)[0] as ErrorCode;
    const known: ErrorCode[] = ["INVALID_ARGUMENT","UNAUTHENTICATED","PATH_FORBIDDEN","READONLY","NOT_FOUND","CONFLICT","PAYLOAD_TOO_LARGE","UNSUPPORTED","UPSTREAM_AUTH_FAILED","UPSTREAM_TIMEOUT","UPSTREAM_UNAVAILABLE","OPENLIST_ERROR"];
    if (known.includes(prefix)) return new AppError(prefix, error.message.slice(prefix.length + 1).trim());
    return new AppError("OPENLIST_ERROR", error.message);
  }
  return new AppError("OPENLIST_ERROR", "Unknown error");
}
