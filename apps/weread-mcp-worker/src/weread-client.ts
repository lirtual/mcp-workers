import { WeReadError } from "./errors.js";

export const WEREAD_GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";
export const WEREAD_SKILL_VERSION = "1.0.4";

export const ALLOWED_API_NAMES = [
  "/store/search",
  "/shelf/sync",
  "/book/info",
  "/book/chapterinfo",
  "/book/getprogress",
  "/user/notebooks",
  "/book/bookmarklist",
  "/review/list/mine",
  "/book/bestbookmarks",
  "/book/readreviews",
  "/readdata/detail",
  "/review/list",
  "/book/recommend",
  "/book/similar",
] as const;

export type AllowedApiName = (typeof ALLOWED_API_NAMES)[number];

const ALLOWED_API_SET = new Set<string>(ALLOWED_API_NAMES);
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export type FetchLike = typeof fetch;

export interface WeReadClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  gatewayUrl?: string;
}

export class WeReadClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly gatewayUrl: string;

  constructor(options: WeReadClientOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.gatewayUrl = options.gatewayUrl ?? WEREAD_GATEWAY_URL;
  }

  async call<T extends Record<string, unknown>>(
    apiName: AllowedApiName,
    businessParams: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.apiKey) {
      throw new WeReadError("WEREAD_AUTH_FAILED", "未配置微信读书 API Key。配置 WEREAD_API_KEY 后再试。");
    }

    if (!ALLOWED_API_SET.has(apiName)) {
      throw new WeReadError("WEREAD_BAD_REQUEST", `不允许调用未列入白名单的微信读书接口：${apiName}`);
    }

    const body = {
      ...businessParams,
      api_name: apiName,
      skill_version: WEREAD_SKILL_VERSION,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(this.gatewayUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (RETRYABLE_STATUS.has(response.status) && attempt === 0) {
          continue;
        }

        if (!response.ok) {
          throw this.httpError(response);
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new WeReadError(
            "WEREAD_UPSTREAM_ERROR",
            "微信读书返回了无法解析的响应。",
            { httpStatus: response.status },
          );
        }

        if (!isRecord(payload)) {
          throw new WeReadError("WEREAD_UPSTREAM_ERROR", "微信读书返回了非对象响应。", {
            httpStatus: response.status,
          });
        }

        if (payload.upgrade_info != null) {
          throw new WeReadError(
            "WEREAD_SKILL_UPGRADE_REQUIRED",
            "微信读书 Skill 协议需要升级，已停止本次操作。",
            { httpStatus: response.status, upgradeInfo: payload.upgrade_info },
          );
        }

        if (typeof payload.errcode === "number" && payload.errcode !== 0) {
          const upstreamMessage =
            typeof payload.errmsg === "string"
              ? payload.errmsg
              : typeof payload.message === "string"
                ? payload.message
                : "微信读书上游返回业务错误。";

          throw new WeReadError("WEREAD_UPSTREAM_ERROR", upstreamMessage, {
            httpStatus: response.status,
            upstreamCode: payload.errcode,
          });
        }

        return payload as T;
      } catch (error) {
        if (error instanceof WeReadError) throw error;

        if (isAbortError(error)) {
          throw new WeReadError("WEREAD_TIMEOUT", "微信读书请求超时。", undefined);
        }

        if (attempt === 0) continue;
        throw new WeReadError("WEREAD_UPSTREAM_ERROR", "微信读书网络请求失败。", undefined);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new WeReadError("WEREAD_UPSTREAM_ERROR", "微信读书请求失败。", undefined);
  }

  private httpError(response: Response): WeReadError {
    const details = {
      httpStatus: response.status,
      retryAfter: response.headers.get("Retry-After") ?? undefined,
    };

    if (response.status === 401 || response.status === 403) {
      return new WeReadError("WEREAD_AUTH_FAILED", "微信读书鉴权失败，请检查 API Key。", details);
    }
    if (response.status === 404) {
      return new WeReadError("WEREAD_NOT_FOUND", "微信读书资源不存在。", details);
    }
    if (response.status === 429) {
      return new WeReadError("WEREAD_RATE_LIMITED", "微信读书请求过于频繁，请稍后再试。", details);
    }
    if (response.status >= 400 && response.status < 500) {
      return new WeReadError("WEREAD_BAD_REQUEST", "微信读书拒绝了当前请求。", details);
    }
    return new WeReadError("WEREAD_UPSTREAM_ERROR", "微信读书上游服务异常。", details);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
