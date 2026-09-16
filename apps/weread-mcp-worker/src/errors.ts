export const WEREAD_ERROR_CODES = [
  "WEREAD_AUTH_FAILED",
  "WEREAD_RATE_LIMITED",
  "WEREAD_BAD_REQUEST",
  "WEREAD_NOT_FOUND",
  "WEREAD_TIMEOUT",
  "WEREAD_UPSTREAM_ERROR",
  "WEREAD_SKILL_UPGRADE_REQUIRED",
] as const;

export type WeReadErrorCode = (typeof WEREAD_ERROR_CODES)[number];

export interface SafeErrorDetails {
  httpStatus?: number;
  retryAfter?: string;
  upstreamCode?: number | string;
  upgradeInfo?: unknown;
}

export class WeReadError extends Error {
  readonly code: WeReadErrorCode;
  readonly details?: SafeErrorDetails;

  constructor(code: WeReadErrorCode, message: string, details?: SafeErrorDetails) {
    super(message);
    this.name = "WeReadError";
    this.code = code;
    this.details = details;
  }
}

export function toSafeError(error: unknown): {
  code: WeReadErrorCode;
  message: string;
  details?: SafeErrorDetails;
} {
  if (error instanceof WeReadError) {
    return { code: error.code, message: error.message, details: error.details };
  }

  return {
    code: "WEREAD_UPSTREAM_ERROR",
    message: "微信读书服务调用失败，请稍后再试。",
  };
}
