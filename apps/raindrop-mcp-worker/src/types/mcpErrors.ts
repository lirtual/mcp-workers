export class McpError extends Error {
  constructor(
    public code: string,
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export class NotFoundError extends McpError {
  constructor(message: string, cause?: unknown) {
    super("NOT_FOUND", message, cause);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends McpError {
  constructor(message: string, cause?: unknown) {
    super("VALIDATION_ERROR", message, cause);
    this.name = "ValidationError";
  }
}

export class AuthError extends McpError {
  constructor(message: string, cause?: unknown) {
    super("AUTH_ERROR", message, cause);
    this.name = "AuthError";
  }
}

export class RateLimitError extends McpError {
  constructor(message: string, cause?: unknown) {
    super("RATE_LIMITED", message, cause);
    this.name = "RateLimitError";
  }
}

export class UpstreamError extends McpError {
  constructor(message: string, cause?: unknown) {
    super("UPSTREAM_ERROR", message, cause);
    this.name = "UpstreamError";
  }
}

/** The upstream explicitly rejected the operation. A submitted write is failed,
 * not unknown, and must not be retried automatically. */
export class UpstreamRejectedError extends McpError {
  constructor(message: string, cause?: unknown) {
    super("UPSTREAM_REJECTED", message, cause);
    this.name = "UpstreamRejectedError";
  }
}

export type KnownMcpError =
  NotFoundError | ValidationError | AuthError | RateLimitError | UpstreamError | UpstreamRejectedError;

/** A write was acknowledged, but its returned representation is unavailable. */
export class WriteResultUnavailableError extends McpError {
  constructor() {
    super("WRITE_RESULT_UNAVAILABLE", "Write accepted; read the target for result details.");
  }
}
