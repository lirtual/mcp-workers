export type EmailErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_DISABLED"
  | "AUTH_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT";

export class EmailToolError extends Error {
  constructor(
    public readonly code: EmailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EmailToolError";
  }
}
