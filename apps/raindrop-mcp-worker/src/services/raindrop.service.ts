// Simple, clean openapi-fetch REST client
import createClient from "openapi-fetch";
import {
  AuthError,
  McpError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from "../types/mcpErrors.js";
import type { components, paths } from "../types/raindrop.schema.js";
import { createLogger } from "../utils/logger.js";
import { ExecutionBudget } from "./execution-budget.js";

type Bookmark = components["schemas"]["Bookmark"];
type Collection = components["schemas"]["Collection"];
type Highlight = components["schemas"]["Highlight"];
type HighlightColor = NonNullable<Highlight["color"]>;

export interface RaindropServiceConfig {
  accessToken?: string;
  maxReadRetries?: number;
  debugHttp?: boolean;
  budget?: ExecutionBudget;
}

export default class RaindropService {
  private client;
  private logger = createLogger("raindrop-service");

  // These caches are intentionally request/service-instance scoped. The Worker
  // creates a fresh service for each stateless MCP request, so TTL-based cache
  // semantics would falsely imply cross-request persistence.
  private cacheCollections = new Map<string, unknown>();
  private cacheBookmarks = new Map<string, unknown>();
  private cacheSearch = new Map<string, unknown>();
  private readonly maxRateLimitRetries: number;
  public readonly budget: ExecutionBudget;

  constructor(config: string | RaindropServiceConfig = {}) {
    const normalized: RaindropServiceConfig =
      typeof config === "string" ? { accessToken: config } : config;
    this.budget = normalized.budget ?? new ExecutionBudget();
    const maxReadRetries = normalized.maxReadRetries;
    this.maxRateLimitRetries =
      maxReadRetries !== undefined &&
      Number.isInteger(maxReadRetries) &&
      maxReadRetries >= 0
        ? Math.min(3, maxReadRetries)
        : 3;
    const accessToken = normalized.accessToken ?? "";
    const debugHttp = normalized.debugHttp ?? false;

    this.client = createClient<paths>({
      baseUrl: "https://api.raindrop.io/rest/v1",
      fetch: (request: Request) => this.budget.fetch(request),
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    this.client.use({
      onRequest({ request }) {
        if (debugHttp) {
          // Use the application logger so request diagnostics follow the same redaction path.
          const logger = createLogger("raindrop-service");
          logger.debug(`${request.method} ${new URL(request.url).pathname}`);
        }
        return request;
      },
      onResponse({ response }) {
        if (!response.ok) {
          if (response.status === 401)
            throw new AuthError("Unauthorized: check RAINDROP_ACCESS_TOKEN");
          if (response.status === 429) {
            const retryAfterMs =
              RaindropService.parseRetryAfterMs(
                response.headers.get("retry-after"),
              ) ??
              RaindropService.parseRateLimitResetMs(
                response.headers.get("x-ratelimit-reset"),
              );
            const message =
              retryAfterMs !== undefined
                ? `Rate limited by Raindrop.io; retry in ${Math.ceil(retryAfterMs / 1000)}s`
                : "Rate limited by Raindrop.io";
            throw new RateLimitError(message, {
              status: 429,
              retryAfterMs,
            });
          }
          if (response.status === 403)
            throw new AuthError("Forbidden: Raindrop access is not permitted");
          if (response.status === 404)
            throw new NotFoundError("Resource not found");
          throw new UpstreamError(
            `API Error: ${response.status} ${response.statusText}`,
            { status: response.status },
          );
        }
        return response;
      },
    });
  }

  private static parseRetryAfterMs(
    retryAfterHeader: string | null,
  ): number | undefined {
    if (!retryAfterHeader) return undefined;

    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }

    const retryAt = Date.parse(retryAfterHeader);
    if (!Number.isNaN(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }

    return undefined;
  }

  private static parseRateLimitResetMs(
    resetHeader: string | null,
  ): number | undefined {
    if (!resetHeader) return undefined;

    const resetEpochSeconds = Number(resetHeader);
    if (Number.isNaN(resetEpochSeconds) || resetEpochSeconds < 0) {
      return undefined;
    }

    const resetAtMs = resetEpochSeconds * 1000;
    return Math.max(0, resetAtMs - Date.now());
  }

  private getUpstreamRetryAfterMs(err: unknown): number | undefined {
    if (!(err instanceof RateLimitError)) return undefined;

    const cause = err.cause as { retryAfterMs?: unknown } | undefined;
    const retryAfterMs = Number(cause?.retryAfterMs);
    return Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? retryAfterMs
      : undefined;
  }

  private async withWriteRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    return this.withRateLimit(fn, "write");
  }

  private async withRateLimit<T>(
    fn: () => Promise<T>,
    retryMode: "read" | "write" = "read",
    retryCount = 0,
    startedAtMs = Date.now(),
  ): Promise<T> {
    const maxRetries = this.maxRateLimitRetries;
    const readRetryBudgetMs = Math.min(15_000, this.budget.remainingMs());
    try {
      return await fn();
    } catch (err: any) {
      // Non-retryable errors: auth, not found, validation
      if (err instanceof AuthError || err instanceof NotFoundError) {
        throw err;
      }

      // Once a write has reached the upstream request, never resubmit it
      // automatically: the remote mutation may already have succeeded.
      if (err instanceof RateLimitError) {
        if (retryMode === "write") {
          throw err;
        }

        const retryAfterMs = this.getUpstreamRetryAfterMs(err);
        const backoffMs =
          retryAfterMs !== undefined
            ? retryAfterMs + 250
            : Math.min(750 * Math.pow(2, retryCount), 10000);
        const elapsedMs = Date.now() - startedAtMs;
        const remainingBudgetMs = Math.min(
          this.budget.remainingMs(),
          Math.max(0, readRetryBudgetMs - elapsedMs),
        );

        if (retryCount >= maxRetries) {
          throw new RateLimitError(
            `Upstream rate limit exceeded after ${maxRetries} retries`,
            { status: 429, retryAfterMs },
          );
        }

        if (backoffMs > remainingBudgetMs) {
          throw new RateLimitError(
            `Upstream retry delay ${Math.ceil(backoffMs / 1000)}s exceeds remaining read retry budget ${Math.ceil(remainingBudgetMs / 1000)}s`,
            { status: 429, retryAfterMs: backoffMs },
          );
        }

        this.logger.warn(
          `Upstream rate limited, retrying in ${Math.ceil(backoffMs / 1000)}s (attempt ${retryCount + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.withRateLimit(
          fn,
          retryMode,
          retryCount + 1,
          startedAtMs,
        );
      }

      // Retry transient upstream errors only for read operations. Writes are
      // intentionally at-most-once from this client once submitted upstream.
      if (
        err instanceof UpstreamError &&
        (Boolean((err.cause as { network?: boolean } | undefined)?.network) ||
          Number((err.cause as { status?: number } | undefined)?.status) >= 500) &&
        retryMode === "read" &&
        retryCount < maxRetries
      ) {
        const backoffMs = Math.min(500 * Math.pow(2, retryCount), 5000);
        const elapsedMs = Date.now() - startedAtMs;
        const remainingBudgetMs = Math.min(
          this.budget.remainingMs(),
          Math.max(0, readRetryBudgetMs - elapsedMs),
        );
        if (backoffMs > remainingBudgetMs) {
          throw err;
        }

        this.logger.warn(
          `Transient error, retrying in ${Math.ceil(backoffMs / 1000)}s (attempt ${retryCount + 1}/${maxRetries}): ${err.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.withRateLimit(
          fn,
          retryMode,
          retryCount + 1,
          startedAtMs,
        );
      }

      throw err instanceof Error
        ? err
        : new UpstreamError("Unknown upstream error", err);
    }
  }

  /**
   * Complete collection metadata requires two official endpoints. Reject invalid
   * responses before combining them; /collections alone omits nested nodes.
   */
  async listCollectionsV3(): Promise<Collection[]> {
    const read = async (endpoint: "/collections" | "/collections/childrens") => {
      const { data } = await this.withRateLimit<any>(() =>
        (this.client as any).GET(endpoint),
      );
      if (data?.result !== true || !Array.isArray(data.items)) {
        throw new UpstreamError(`Invalid collection index response from ${endpoint}`);
      }
      if (data.items.length > 1000) {
        throw new McpError("RESOURCE_LIMIT", "Collection metadata exceeds 1000 items");
      }
      for (const item of data.items as Collection[]) {
        if (!Number.isSafeInteger(item?._id) || item._id <= 0 ||
            typeof item.title !== "string") {
          throw new UpstreamError("Collection metadata contains an invalid item");
        }
      }
      return data.items as Collection[];
    };
    const roots = await read("/collections");
    const children = await read("/collections/childrens");
    const byId = new Map<number, Collection>();
    // Child records take precedence when an ID appears in both responses.
    for (const collection of [...roots, ...children]) {
      byId.set(collection._id, collection);
      if (byId.size > 1000) {
        throw new McpError("RESOURCE_LIMIT", "Collection metadata exceeds 1000 unique items");
      }
    }
    return [...byId.values()].sort((a, b) => a._id - b._id);
  }

  async createCollectionV3(
    title: string,
    parent?: { $id: number },
  ): Promise<Collection> {
    const { data } = await this.withWriteRateLimit<any>(() =>
      (this.client as any).POST("/collection", {
        body: { title, ...(parent === undefined ? {} : { parent }) },
      }),
    );
    if (data?.result !== true || !data.item) {
      throw new UpstreamError("Collection create acknowledgement is missing");
    }
    this.cacheCollections.clear();
    return data.item as Collection;
  }

  async updateCollectionV3(
    id: number,
    updates: { title?: string; parent?: { $id: number } | null },
  ): Promise<Collection> {
    const { data } = await this.withWriteRateLimit<any>(() =>
      (this.client as any).PUT("/collection/{id}", {
        params: { path: { id } },
        body: updates,
      }),
    );
    if (data?.result !== true || !data.item) {
      throw new UpstreamError("Collection update acknowledgement is missing");
    }
    this.cacheCollections.clear();
    return data.item as Collection;
  }

  async deleteCollectionV3(id: number): Promise<void> {
    const { data } = await this.withWriteRateLimit<any>(() =>
      (this.client as any).DELETE("/collection/{id}", {
        params: { path: { id } },
      }),
    );
    if (data?.result !== true) {
      throw new UpstreamError("Collection delete acknowledgement is missing");
    }
    this.cacheCollections.clear();
  }

  /**
   * Fetch a single collection by ID
   * Raindrop.io API: GET /collection/{id}
   */
  async getCollection(id: number, skipCache = false): Promise<Collection> {
    if (!skipCache) {
      const cached = await this.cacheCollections.get(`id:${id}`);
      if (cached) {
        this.logger.debug(`Cache HIT: getCollection ${id}`);
        return cached as Collection;
      }
    }

    const collection = await this.withRateLimit(async () => {
      const { data } = await this.client.GET("/collection/{id}", {
        params: { path: { id } },
      });
      if (data?.result === false) throw new UpstreamError("Collection detail was rejected");
      if (!data?.item) throw new NotFoundError("Collection not found");
      return data.item as Collection;
    });

    this.cacheCollections.set(`id:${id}`, collection);
    return collection;
  }

  /**
   * v3 read/write tracer: direct documented endpoints with no legacy search
   * shortcuts, and only explicitly writable fields in mutation bodies.
   */
  async listRaindropsV3(params: {
    collectionId: number;
    search?: string;
    sort: string;
    page: number;
    perpage: number;
    nested: boolean;
  }): Promise<{ items: Bookmark[]; count: number | null }> {
    const { data } = await this.withRateLimit(async () =>
      (this.client as any).GET("/raindrops/{collectionId}", {
        params: {
          path: { collectionId: params.collectionId },
          query: {
            page: params.page,
            perpage: params.perpage,
            sort: params.sort,
            nested: params.nested,
            ...(params.search === undefined ? {} : { search: params.search }),
          },
        },
      }),
    );
    if (!data || data.result === false || !Array.isArray(data.items)) {
      throw new UpstreamError("Raindrop list response is missing or rejected");
    }
    return {
      items: data.items as Bookmark[],
      count: Number.isSafeInteger(data.count) && data.count >= 0
        ? data.count : null,
    };
  }

  async createRaindropV3(fields: {
    link: string;
    title?: string;
    excerpt?: string;
    note?: string;
    tags?: string[];
    important?: boolean;
    collection?: { $id: number };
  }): Promise<Bookmark> {
    const { data } = await this.withWriteRateLimit(async () =>
      (this.client as any).POST("/raindrop", {
        body: { ...fields, collection: fields.collection ?? { $id: -1 }, pleaseParse: {} },
      }),
    );
    if (!data?.item) throw new UpstreamError("Upstream create response has no bookmark");
    this.cacheSearch.clear();
    return data.item as Bookmark;
  }

  async updateRaindropV3(id: number, fields: {
    link?: string;
    title?: string;
    excerpt?: string;
    note?: string;
    tags?: string[];
    important?: boolean;
    collection?: { $id: number };
  }): Promise<Bookmark> {
    const { data } = await this.withWriteRateLimit(async () =>
      (this.client as any).PUT("/raindrop/{id}", {
        params: { path: { id } },
        body: fields,
      }),
    );
    if (!data?.item) throw new UpstreamError("Upstream update response has no bookmark");
    this.cacheBookmarks.delete(`id:${id}`);
    this.cacheSearch.clear();
    return data.item as Bookmark;
  }

  /**
   * One source-scoped upstream mutation. The caller validates the explicit IDs
   * and source. Never retry a submitted write or manufacture per-ID results.
   */
  async mutateRaindropsV3(
    kind: "update" | "delete",
    collectionId: number,
    ids: number[],
    fields: { important?: boolean; tags?: string[]; collection?: { $id: number } } = {},
  ): Promise<{ modified: number | null }> {
    const { data } = await this.withWriteRateLimit(async () =>
      kind === "update"
        ? (this.client as any).PUT("/raindrops/{collectionId}", {
            params: { path: { collectionId } },
            body: { ids, ...fields },
          })
        : (this.client as any).DELETE("/raindrops/{collectionId}", {
            params: { path: { collectionId } },
            body: { ids },
          }),
    );
    // A successful HTTP status alone does not establish that the mutation ran.
    // Missing/malformed acknowledgement is uncertain once a write was submitted.
    if (data?.result !== true) {
      throw new UpstreamError("Upstream mutation acknowledgement is missing");
    }
    this.cacheBookmarks.clear();
    this.cacheSearch.clear();
    this.cacheCollections.clear();
    return {
      modified: Number.isSafeInteger(data.modified) && data.modified >= 0
        ? data.modified : null,
    };
  }

  /**
   * Fetch a single bookmark by ID
   * Raindrop.io API: GET /raindrop/{id}
   */
  async getBookmark(id: number, skipCache = false): Promise<Bookmark> {
    if (!skipCache) {
      const cached = await this.cacheBookmarks.get(`id:${id}`);
      if (cached) {
        this.logger.debug(`Cache HIT: getBookmark ${id}`);
        return cached as Bookmark;
      }
    }

    const bookmark = await this.withRateLimit(async () => {
      const { data } = await this.client.GET("/raindrop/{id}", {
        params: { path: { id } },
      });
      if (data?.result === false) throw new UpstreamError("Bookmark detail was rejected");
      if (!data?.item) throw new NotFoundError("Bookmark not found");
      return data.item as any as Bookmark;
    });

    this.cacheBookmarks.set(`id:${id}`, bookmark);
    return bookmark;
  }

  /**
   * Fetch AI-powered suggestions for a URL or existing bookmark.
   * Raindrop.io API: POST /raindrop/suggest or GET /raindrop/{id}/suggest
   */
  async getSuggestions(
    target: string | number,
  ): Promise<components["schemas"]["SuggestionsResponse"]> {
    if (typeof target === "number") {
      return this.withRateLimit(async () => {
        const { data } = await this.client.GET("/raindrop/{id}/suggest", {
          params: { path: { id: target } },
        });
        if (!data || data.result === false) throw new UpstreamError("Suggestions response is missing or rejected");
        return data as components["schemas"]["SuggestionsResponse"];
      });
    }
    // POST suggestion is read-like, but must not be replayed after submission.
    return this.withWriteRateLimit(async () => {
      const { data } = await this.client.POST("/raindrop/suggest", {
        body: { link: target },
      });
      if (!data || data.result === false) throw new UpstreamError("Suggestions response is missing or rejected");
      return data as components["schemas"]["SuggestionsResponse"];
    });
  }

  /** Official Trash endpoint; unlike the legacy helper this is not a batch bookmark delete. */
  async emptyTrashV3(): Promise<void> {
    const { data } = await this.withWriteRateLimit<any>(() =>
      (this.client as any).DELETE("/collection/-99"),
    );
    if (data?.result !== true) {
      throw new UpstreamError("Trash empty acknowledgement is missing");
    }
    this.cacheBookmarks.clear();
    this.cacheSearch.clear();
  }

  /**
   * Official v3 tag endpoint: global scope omits collectionId entirely.
   * Old /tags/0 is not an authenticated alias for the global endpoint.
   */
  async listTagsV3(collectionId?: number): Promise<Array<{ _id: string; count: number }>> {
    const { data } = await this.withRateLimit(async () =>
      collectionId === undefined
        ? (this.client as any).GET("/tags")
        : (this.client as any).GET("/tags/{collectionId}", {
            params: { path: { collectionId } },
          }),
    );
    if (!data || data.result === false || !Array.isArray(data.items)) {
      throw new UpstreamError("Upstream tags response is invalid or rejected");
    }
    if (data.items.length > 5000) {
      throw new McpError("RESOURCE_LIMIT", "Tag metadata exceeds the 5000-item limit");
    }
    if (!data.items.every((item: unknown) => {
      const tag = item as { _id?: unknown; count?: unknown };
      return tag && typeof tag._id === "string" && typeof tag.count === "number";
    })) {
      throw new UpstreamError("Upstream tags response contains invalid items");
    }
    return data.items as Array<{ _id: string; count: number }>;
  }

  /**
   * One tag operation by explicit official scope. A submitted mutation is never retried.
   * API only acknowledges the whole operation; it supplies no per-tag modified list.
   */
  async mutateTagsV3(
    action: "rename" | "merge" | "delete",
    tags: string[],
    collectionId?: number,
    replace?: string,
  ): Promise<void> {
    const endpoint = collectionId === undefined ? "/tags" : "/tags/{collectionId}";
    const options = {
      ...(collectionId === undefined ? {} : { params: { path: { collectionId } } }),
      body: action === "delete" ? { tags } : { tags, replace },
    };
    const { data } = await this.withWriteRateLimit(async () =>
      action === "delete"
        ? (this.client as any).DELETE(endpoint, options)
        : (this.client as any).PUT(endpoint, options),
    );
    if (data?.result !== true) {
      throw new UpstreamError("Upstream tag mutation acknowledgement is missing");
    }
    this.cacheSearch.clear();
    this.cacheBookmarks.clear();
  }

  /**
   * Fetch user info
   * Raindrop.io API: GET /user
   */
  async getUserInfo(): Promise<{ email: string; [key: string]: any }> {
    return this.withRateLimit(async () => {
      const { data } = await this.client.GET("/user");
      if (!data?.user) throw new NotFoundError("User not found");
      return data.user;
    });
  }

  /**
   * Fetch user statistics (total bookmarks, collections, highlights, tags)
   * Raindrop.io API: GET /user/stats; unavailable counters stay null
   */
  async getUserStats(): Promise<{
    bookmarks: number | null;
    trash: number | null;
    collections: null;
    highlights: null;
    tags: null;
    pro: boolean | null;
  }> {
    return this.withRateLimit(async () => {
      const { data } = await this.client.GET("/user/stats");
      const payload = data as {
        result?: boolean;
        items?: Array<{ _id?: number; count?: number }>;
        pro?: boolean;
        meta?: { pro?: boolean };
      } | undefined;
      if (!payload || payload.result === false || !Array.isArray(payload.items)) {
        throw new UpstreamError("Raindrop user statistics are unavailable");
      }
      const count = (id: number): number | null => {
        const item = payload.items?.find((entry) => entry._id === id);
        return item && typeof item.count === "number" ? item.count : null;
      };
      return {
        bookmarks: count(0),
        trash: count(-99),
        collections: null,
        highlights: null,
        tags: null,
        pro: typeof payload.meta?.pro === "boolean" ? payload.meta.pro :
          typeof payload.pro === "boolean" ? payload.pro : null,
      };
    });
  }

  /**
   * Fetch one official highlight page. Never infer all highlights from one
   * bookmark-list page; a single bookmark is handled by its detail endpoint.
   */
  async listHighlightsV3(
    collectionId: number | undefined,
    page: number,
    perpage: number,
  ): Promise<{ items: Highlight[]; count: number | null }> {
    const { data } = await this.withRateLimit(async () =>
      collectionId === undefined
        ? (this.client as any).GET("/highlights", { params: { query: { page, perpage } } })
        : (this.client as any).GET("/highlights/{collectionId}", {
            params: { path: { collectionId }, query: { page, perpage } },
          }),
    );
    if (!data || data.result === false || !Array.isArray(data.items)) {
      throw new UpstreamError("Upstream highlights response is invalid or rejected");
    }
    return {
      items: data.items as Highlight[],
      count: Number.isSafeInteger(data.count) && data.count >= 0 ? data.count : null,
    };
  }

  /**
   * Write one highlight through the documented single-bookmark update API.
   * The upstream does not provide a per-highlight mutation acknowledgement.
   */
  async mutateHighlightV3(
    raindropId: number,
    operation: "create" | "update" | "delete",
    highlight: { _id?: string; text?: string; note?: string; color?: HighlightColor },
  ): Promise<{ item: Bookmark | null; targetVerified: boolean }> {
    const { data } = await this.withWriteRateLimit(async () =>
      (this.client as any).PUT("/raindrop/{id}", {
        params: { path: { id: raindropId } },
        body: { highlights: [highlight] },
      }),
    );
    if (data?.result !== true) {
      throw new UpstreamError("Upstream highlight mutation acknowledgement is missing");
    }
    const item = data.item && typeof data.item === "object" ? data.item as Bookmark : null;
    this.cacheBookmarks.delete(`id:${raindropId}`);
    this.cacheSearch.clear();
    const returned = item?.highlights;
    let targetVerified = false;
    if (Array.isArray(returned) && highlight._id) {
      const matched = returned.find((candidate) => candidate._id === highlight._id);
      if (operation === "delete") {
        targetVerified = matched === undefined;
      } else if (operation === "update" && matched) {
        targetVerified = Object.entries(highlight).every(([key, value]) =>
          key === "_id" || (matched as unknown as Record<string, unknown>)[key] === value
        );
      }
    }
    // For creation the generated _id is not returned separately: do not guess
    // it from the text, which can be identical to an existing highlight.
    return { item, targetVerified };
  }

}
