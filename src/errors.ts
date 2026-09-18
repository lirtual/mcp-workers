export type EmailErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_DISABLED"
  | "AUTH_FAILED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT"
  | "FOLDER_NOT_FOUND"
  | "MESSAGE_NOT_FOUND"
  | "MESSAGE_REFERENCE_STALE"
  | "CURSOR_INVALID"
  | "MESSAGE_TOO_LARGE"
  | "MODIFY_DISABLED"
  | "TRASH_NOT_AVAILABLE"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_DECLINED"
  | "CONFIRMATION_UNAVAILABLE"
  | "MODIFY_OUTCOME_UNKNOWN"
  | "SEND_DISABLED"
  | "SEND_OUTCOME_UNKNOWN"
  | "SENDER_NOT_ALLOWED"
  | "RECIPIENT_LIMIT_EXCEEDED"
  | "UNSUPPORTED_PROVIDER_CAPABILITY";

export class EmailToolError extends Error {
  constructor(
    public readonly code: EmailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EmailToolError";
  }
}
