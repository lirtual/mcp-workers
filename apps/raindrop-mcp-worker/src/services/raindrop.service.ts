// Simple, clean openapi-fetch REST client
import createClient from "openapi-fetch";
import { z } from "zod";
import {
  TrashEmptyInputSchema,
  type TrashEmptyOutcome,
} from "../types/trash.schemas.js";
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  UnknownWriteError,
  ValidationError,
} from "../types/mcpErrors.js";
import {
  CollectionDeleteInputSchema,
  CollectionRemoveEmptyInputSchema,
  CollectionDeletionMemberSchema,
  CollectionDeletionOutputSchema,
  BookmarkBatchDeleteInputSchema,
  BookmarkBatchUpdateInputSchema,
  BookmarkBatchOutcomeSchema,
  HighlightBookmarkIdSchema,
  HighlightIdSchema,
  HighlightRecordSchema,
  HighlightCreateFieldsSchema,
  HighlightUpdateFieldsSchema,
  HighlightWriteOutcomeSchema,
  TagScopeSchema,
  TagNameSchema,
  TagNamesSchema,
} from "../types/raindrop-zod.schemas.js";
import type { components, paths } from "../types/raindrop.schema.js";
import { createLogger } from "../utils/logger.js";

type Bookmark = components["schemas"]["Bookmark"];
type Collection = components["schemas"]["Collection"];
type Highlight = components["schemas"]["Highlight"];
type HighlightRecord = z.infer<typeof HighlightRecordSchema>;
export type HighlightWriteOutcome = z.infer<typeof HighlightWriteOutcomeSchema>;

export type BookmarkBatchOutcome = z.infer<typeof BookmarkBatchOutcomeSchema>;

export interface RaindropServiceConfig {
  accessToken?: string;
  maxReadRetries?: number;
  debugHttp?: boolean;
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
  // One Service instance per incoming MCP request in the Worker.
  private upstreamRequestCount = 0;

  constructor(config: string | RaindropServiceConfig = {}) {
    const normalized: RaindropServiceConfig =
      typeof config === "string" ? { accessToken: config } : config;
    const maxReadRetries = normalized.maxReadRetries;
    this.maxRateLimitRetries =
      maxReadRetries !== undefined &&
      Number.isInteger(maxReadRetries) &&
      maxReadRetries >= 0
        ? maxReadRetries
        : 3;
    const accessToken = normalized.accessToken ?? "";
    const debugHttp = normalized.debugHttp ?? false;

    this.client = createClient<paths>({
      baseUrl: "https://api.raindrop.io/rest/v1",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    this.client.use({
      onRequest: ({ request }) => {
        // Count every actual HTTP attempt, including the retry calls below.
        // Reject request 61 before dispatch; this is not an account-wide limiter.
        if (this.upstreamRequestCount >= 60) {
          throw new ValidationError("Per-invocation upstream request budget of 60 exhausted");
        }
        this.upstreamRequestCount++;
        if (debugHttp) {
          // Use the application logger so request diagnostics follow the same redaction path.
          const logger = createLogger("raindrop-service");
          logger.debug(`${request.method} ${request.url}`);
        }
        return request;
      },
      onResponse({ response }) {
        if (!response.ok) {
          if (response.status === 401)
            throw new AuthError("Unauthorized: check RAINDROP_ACCESS_TOKEN");
          if (response.status === 403)
            throw new AuthError("Raindrop API denied this operation (HTTP 403 Forbidden); cause not specified");
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
    const readRetryBudgetMs = 15_000;
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
        const remainingBudgetMs = Math.max(0, readRetryBudgetMs - elapsedMs);

        if (retryCount >= maxRetries) {
          throw new RateLimitError(
            `Upstream rate limit exceeded after ${maxRetries} retries`,
            err,
          );
        }

        if (backoffMs > remainingBudgetMs) {
          throw new RateLimitError(
            `Upstream retry delay ${Math.ceil(backoffMs / 1000)}s exceeds remaining read retry budget ${Math.ceil(remainingBudgetMs / 1000)}s`,
            err,
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
        retryMode === "read" &&
        retryCount < maxRetries
      ) {
        const backoffMs = Math.min(500 * Math.pow(2, retryCount), 5000);
        const elapsedMs = Date.now() - startedAtMs;
        const remainingBudgetMs = Math.max(0, readRetryBudgetMs - elapsedMs);
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
   * Fetch all collections
   * Raindrop.io API: GET /collections
   */
  async getCollections(skipCache = false): Promise<Collection[]> {
    if (!skipCache) {
      const cached = await this.cacheCollections.get("all");
      if (cached) {
        this.logger.debug("Cache HIT: getCollections");
        return cached as Collection[];
      }
    }

    this.logger.debug("Cache MISS: getCollections");
    const collections = await this.withRateLimit(async () => {
      const { data } = await this.client.GET("/collections");
      return [...((data?.items as Collection[]) || [])];
    });

    this.cacheCollections.set("all", collections);
    return collections;
  }

  /**
   * Fetch all nested collections. Official Raindrop API exposes one global
   * /collections/childrens endpoint (not the parent-specific legacy route).
   * The current generated OpenAPI types do not include this endpoint.
   */
  async getAllChildCollections(skipCache = false): Promise<Collection[]> {
    const key = "all-children";
    if (!skipCache) {
      const cached = await this.cacheCollections.get(key);
      if (cached) return cached as Collection[];
    }
    const children = await this.withRateLimit(async () => {
      const { data } = await (this.client as any).GET("/collections/childrens");
      if (!Array.isArray(data?.items)) {
        throw new UpstreamError("Unable to enumerate nested collections");
      }
      return data.items as Collection[];
    });
    this.cacheCollections.set(key, children);
    return children;
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
      if (!data?.item) throw new NotFoundError("Collection not found");
      return data.item as Collection;
    });

    this.cacheCollections.set(`id:${id}`, collection);
    return collection;
  }

  /**
   * Fetch child collections for a parent collection
   * Raindrop.io API: GET /collections/{parentId}/childrens
   */
  async getChildCollections(
    parentId: number,
    skipCache = false,
  ): Promise<Collection[]> {
    if (!skipCache) {
      const cached = await this.cacheCollections.get(`children:${parentId}`);
      if (cached) {
        this.logger.debug(`Cache HIT: getChildCollections ${parentId}`);
        return cached as Collection[];
      }
    }

    const collections = await this.withRateLimit(async () => {
      const { data } = await this.client.GET(
        "/collections/{parentId}/childrens",
        {
          params: { path: { parentId } },
        },
      );
      return [...((data?.items as Collection[]) || [])];
    });

    this.cacheCollections.set(`children:${parentId}`, collections);
    return collections;
  }

  /**
   * Get all collections organized as a tree with breadcrumb paths.
   */
  async getCollectionTree(
    skipCache = false,
  ): Promise<Array<Collection & { path: string; children: any[] }>> {
    const collections = await this.getCollections(skipCache);
    const tree: any[] = [];
    const map = new Map<number, any>();

    // Initialize map
    collections.forEach((c) => {
      map.set(c._id, { ...c, children: [], path: c.title });
    });

    // Build hierarchy and paths
    collections.forEach((c) => {
      const node = map.get(c._id);
      if (c.parent?.$id && map.has(c.parent.$id)) {
        const parent = map.get(c.parent.$id);
        parent.children.push(node);
        node.path = `${parent.path} > ${c.title}`;
      } else {
        tree.push(node);
      }
    });

    return tree;
  }

  /**
   * Create a new collection
   * Raindrop.io API: POST /collection
   */
  async createCollection(
    title: string,
    isPublic = false,
    parentId?: number,
  ): Promise<Collection> {
    if (!title?.trim()) throw new ValidationError("Collection title is required");
    if (parentId !== undefined) {
      if (!Number.isSafeInteger(parentId) || parentId <= 0) {
        throw new ValidationError("parentId must be a positive collection ID");
      }
      // Validate target parent exists before posting any write.
      await this.getCollection(parentId, true);
    }
    const collection = await this.withWriteRateLimit(async () => {
      const { data } = await this.client.POST("/collection", {
        body: {
          title,
          public: isPublic,
          ...(parentId !== undefined ? { parent: { $id: parentId } } : {}),
        },
      });
      // Official mutation acknowledgment requires result:true and a usable item.
      // A response containing item alongside result:false is not success.
      if (data?.result !== true ||
          !Number.isSafeInteger(data.item?._id) || data.item._id <= 0 ||
          typeof data.item?.title !== "string" || !data.item.title.trim())
        throw new UpstreamError("Collection creation outcome could not be verified");
      return data.item as Collection;
    });

    // Invalidate collections cache
    await this.cacheCollections.clear();
    return collection;
  }

  /**
   * Update a collection
   * Raindrop.io API: PUT /collection/{id}
   */
  async updateCollection(
    id: number,
    updates: Partial<Collection>,
  ): Promise<Collection> {
    const collection = await this.withWriteRateLimit(async () => {
      const { data } = await this.client.PUT("/collection/{id}", {
        params: { path: { id } },
        body: updates,
      });
      if (data?.result !== true || data.item?._id !== id ||
          typeof data.item?.title !== "string" || !data.item.title.trim())
        throw new UpstreamError("Collection update outcome could not be verified");
      // Never report success when the returned collection contradicts a field
      // that this caller explicitly requested to change.
      if (Object.entries(updates).some(([field, expected]) =>
        JSON.stringify(data.item[field as keyof Collection]) !== JSON.stringify(expected)))
        throw new UpstreamError("Collection update was not confirmed by the returned item");
      return data.item as Collection;
    });

    // Invalidate collections cache
    await this.cacheCollections.clear();
    return collection;
  }

  /**
   * Delete a collection
   * Raindrop.io API: DELETE /collection/{id}
   */
  async deleteCollection(id: number): Promise<void> {
    await this.withWriteRateLimit(async () => {
      await this.client.DELETE("/collection/{id}", {
        params: { path: { id } },
      });
    });

    // Invalidate collections cache
    await this.cacheCollections.clear();
  }

  /** Reserve minimum remaining calls before starting a bounded destructive phase. */
  private requireCollectionBudget(attempts: number): void {
    if (this.upstreamRequestCount + attempts > 60)
      throw new ValidationError(
        "Collection preflight exceeds remaining 60 upstream HTTP attempt budget; no further writes dispatched",
      );
  }

  /** Strict fresh hierarchy adapter; generated types omit /collections/childrens. */
  private async deletionTree() {
    const row = z.object({
      _id: z.number().int().positive().safe(),
      title: z.string(),
      parent: z
        .object({ $id: z.number().int().positive().safe() })
        .nullable()
        .optional(),
    });
    const envelope = z.object({ result: z.literal(true), items: z.array(row) });
    const read = async (path: "/collections" | "/collections/childrens") => {
      const data = await this.withRateLimit(async () => {
        // Narrow adapter for the missing official nested-collections path.
        const response = await this.client.GET(path as "/collections");
        return response.data;
      });
      const parsed = envelope.safeParse(data);
      if (!parsed.success)
        throw new ValidationError("Malformed collection hierarchy response");
      return parsed.data.items;
    };
    const roots = await read("/collections");
    const children = await read("/collections/childrens");
    if (children.some((r) => !r.parent))
      throw new ValidationError("Invalid child collection scope");
    // The real API may list the same nested collection in both endpoints.
    // Accept a consistent overlap, favoring the explicit nested parent;
    // reject duplicates within one endpoint and conflicting metadata.
    if (new Set(roots.map(r => r._id)).size !== roots.length ||
        new Set(children.map(r => r._id)).size !== children.length)
      throw new ValidationError("Duplicate collection IDs within one endpoint");
    const tree = new Map<number, { id: number; title: string; parentId: number | null }>();
    for (const r of [...roots, ...children]) {
      const parentId = r.parent?.$id ?? null;
      const old = tree.get(r._id);
      if (old) {
        if (old.title !== r.title ||
            (old.parentId !== null && parentId !== null && old.parentId !== parentId))
          throw new ValidationError("Conflicting collection metadata across upstream lists");
        if (parentId !== null) old.parentId = parentId;
      } else {
        tree.set(r._id, { id: r._id, title: r.title, parentId });
      }
    }
    for (const node of tree.values()) {
      const seen = new Set<number>([node.id]);
      let parent = node.parentId;
      while (parent !== null) {
        if (seen.has(parent) || !tree.has(parent))
          throw new ValidationError(
            "Incomplete or cyclic collection hierarchy",
          );
        seen.add(parent);
        parent = tree.get(parent)!.parentId;
      }
    }
    return tree;
  }

  /** Metadata count is cross-checked against the official direct-only bookmark count. */
  private async deletionMember(node: {
    id: number;
    parentId: number | null;
    title: string;
  }) {
    const data = await this.withRateLimit(
      async () =>
        (
          await this.client.GET("/collection/{id}", {
            params: { path: { id: node.id } },
          })
        ).data,
    );
    const parsed = z
      .object({
        result: z.literal(true),
        item: z.object({
          _id: z.literal(node.id),
          title: z.string(),
          count: z.number().int().nonnegative().safe(),
          parent: z
            .object({ $id: z.number().int().positive().safe() })
            .nullable()
            .optional(),
          access: z.object({ level: z.literal(4) }),
        }),
      })
      .safeParse(data);
    if (
      !parsed.success ||
      (parsed.data.item.parent?.$id ?? null) !== node.parentId
    )
      throw new ValidationError(
        `Cannot verify owner, parent or direct count for collection ${node.id}`,
      );
    const direct = await this.withRateLimit(
      async () =>
        (
          await this.client.GET("/raindrops/{collectionId}", {
            params: {
              path: { collectionId: node.id, id: node.id },
              query: { perpage: 1, nested: false },
            },
          })
        ).data,
    );
    const bookmarks = z
      .object({
        result: z.literal(true),
        count: z.number().int().nonnegative().safe(),
        items: z
          .array(
            z.object({
              _id: z.number().int().positive().safe(),
              collection: z.object({ $id: z.literal(node.id) }),
            }),
          )
          .max(1),
      })
      .safeParse(direct);
    if (
      !bookmarks.success ||
      bookmarks.data.count !== parsed.data.item.count ||
      bookmarks.data.items.length !== Math.min(1, bookmarks.data.count)
    )
      throw new ValidationError(
        `Cannot verify direct bookmarks for collection ${node.id}`,
      );
    return {
      ...node,
      title: parsed.data.item.title,
      count: parsed.data.item.count,
    };
  }

  /** Only the exact boolean acknowledgement establishes a successful cascade. */
  private async deleteVerifiedCollection(
    id: number,
  ): Promise<"succeeded" | "failed" | "unknown"> {
    this.requireCollectionBudget(1);
    return this.withWriteRateLimit(async () => {
      let status: "succeeded" | "failed" | "unknown" = "unknown";
      try {
        const { data } = await this.client.DELETE("/collection/{id}", {
          params: { path: { id } },
        });
        const ack = z
          .object({ result: z.boolean() })
          .safeParse(data as unknown);
        if (ack.success) status = ack.data.result ? "succeeded" : "failed";
      } catch (error) {
        if (
          error instanceof AuthError ||
          error instanceof NotFoundError ||
          error instanceof RateLimitError
        )
          status = "failed";
      }
      if (status !== "failed") {
        this.cacheCollections.clear();
        this.cacheBookmarks.clear();
        this.cacheSearch.clear();
      }
      return status;
    });
  }

  async deleteCollectionPreviewFirst(
    input: z.infer<typeof CollectionDeleteInputSchema>,
  ) {
    return this.collectionDeletion(
      CollectionDeleteInputSchema.parse(input),
      "delete",
    );
  }

  async removeEmptyCollectionsPreviewFirst(
    input: z.infer<typeof CollectionRemoveEmptyInputSchema>,
  ) {
    return this.collectionDeletion(
      CollectionRemoveEmptyInputSchema.parse(input),
      "empty",
    );
  }

  private async collectionDeletion(
    args:
      | z.infer<typeof CollectionDeleteInputSchema>
      | z.infer<typeof CollectionRemoveEmptyInputSchema>,
    operation: "delete" | "empty",
  ): Promise<z.infer<typeof CollectionDeletionOutputSchema>> {
    const rootId = "id" in args ? args.id : args.rootId;
    this.requireCollectionBudget(2);
    const tree = await this.deletionTree();
    const target = tree.get(rootId);
    if (!target)
      throw new ValidationError("Explicit positive root collection not found");
    const inScope = (id: number): boolean => {
      let current: number | null = id;
      while (current !== null) {
        if (current === rootId) return true;
        current = tree.get(current)!.parentId;
      }
      return false;
    };
    const scoped = [...tree.values()]
      .filter((n) => inScope(n.id))
      .sort((a, b) => a.id - b.id);
    const parents = new Set([...tree.values()].map((n) => n.parentId));
    // Reserve every scoped metadata/direct-count pair before enumerating it.
    this.requireCollectionBudget(scoped.length * 2 + (args.confirm ? 1 : 0));
    const collections: z.infer<typeof CollectionDeletionMemberSchema>[] = [];
    for (const node of scoped)
      collections.push(await this.deletionMember(node));
    const candidates =
      operation === "delete"
        ? collections
        : collections.filter((n) => n.count === 0 && !parents.has(n.id));
    const collectionIds = candidates.map((n) => n.id);
    const bookmarkCount = collections.reduce((sum, n) => sum + n.count, 0);
    if (!Number.isSafeInteger(bookmarkCount))
      throw new ValidationError("Bookmark total exceeds safe integer range");
    // Canonical membership is numeric-ID sorted, with stable tuple field order.
    // Bind the full scoped hierarchy even when only empty leaves are candidates.
    const canonical = JSON.stringify([
      "collection-deletion-v1",
      operation,
      rootId,
      collections.map((n) => [n.id, n.parentId, n.count]),
      collectionIds,
    ]);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    );
    const digest =
      "v1:sha256:" +
      Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    const result: z.infer<typeof CollectionDeletionOutputSchema> = {
      preview: !args.confirm,
      rootId,
      target: collections.find((n) => n.id === rootId)!,
      total: collectionIds.length,
      collectionIds,
      collections,
      bookmarkCount,
      digest,
      succeeded: [],
      failed: [],
      unknown: [],
      notExecuted: [],
      reason:
        "Preview only. DELETE cascades descendants and moves bookmarks to Trash. Digest is neither authorization nor a transaction lock; concurrent changes remain possible.",
    };
    if (!args.confirm) return result;
    if (
      args.expectedTotal !== result.total ||
      args.digest !== digest ||
      JSON.stringify(args.collectionIds) !== JSON.stringify(collectionIds)
    )
      throw new ValidationError(
        "Collection snapshot mismatch; preview again. No writes dispatched",
      );
    // Empty candidates were leaves at preview; none can be ancestors of another.
    // Descending depth still makes the execution order explicitly bottom-up.
    const depth = (id: number) => {
      let value = 0;
      let parent = tree.get(id)!.parentId;
      while (parent !== null) {
        value++;
        parent = tree.get(parent)!.parentId;
      }
      return value;
    };
    const execution =
      operation === "delete"
        ? [rootId]
        : [...collectionIds].sort((a, b) => depth(b) - depth(a) || a - b);
    this.requireCollectionBudget(
      operation === "delete" ? 1 : execution.length * 5,
    );
    for (let index = 0; index < execution.length; index++) {
      const id = execution[index]!;
      try {
        if (operation === "empty") {
          this.requireCollectionBudget((execution.length - index) * 5);
          const fresh = await this.deletionTree();
          const node = fresh.get(id);
          if (
            !node ||
            fresh.get(rootId)?.parentId !== tree.get(rootId)!.parentId ||
            node.parentId !== tree.get(id)!.parentId ||
            [...fresh.values()].some((n) => n.parentId === id)
          )
            throw new ValidationError(
              "Candidate moved, missing or no longer a leaf",
            );
          // Verify the entire ancestry still belongs to the approved root scope.
          let ancestor: number | null = id;
          while (ancestor !== null && ancestor !== rootId) {
            if (fresh.get(ancestor)!.parentId !== tree.get(ancestor)?.parentId)
              throw new ValidationError("Candidate ancestry changed");
            ancestor = fresh.get(ancestor)!.parentId;
          }
          if (
            ancestor !== rootId ||
            (await this.deletionMember(node)).count !== 0
          )
            throw new ValidationError(
              "Candidate is no longer an empty scoped leaf",
            );
        }
        const status = await this.deleteVerifiedCollection(id);
        result[status].push(id);
        if (status === "succeeded") continue;
        result.reason = `Stopped on ${status} write; do not automatically retry. Inspect upstream state.`;
      } catch (error) {
        result.failed.push(id);
        result.reason = `Stopped before this write: ${error instanceof Error ? error.message : "preflight failed"}`;
      }
      result.notExecuted = execution.slice(index + 1);
      return result;
    }
    result.reason = execution.length === 0
      ? "No approved empty leaves; no writes dispatched."
      : "All approved DELETE requests acknowledged result:true. Concurrent upstream changes are not transactionally excluded.";
    return result;
  }

  /**
   * Share a collection
   * Raindrop.io API: PUT /collection/{id}/sharing
   */
  async shareCollection(
    id: number,
    level: string,
    emails?: string[],
  ): Promise<{ link: string; access: any[] }> {
    return this.withWriteRateLimit(async () => {
      const body: any = { level };
      if (emails) body.emails = emails;
      const { data } = await this.client.PUT("/collection/{id}/sharing", {
        params: { path: { id } },
        body,
      });
      return {
        link: data?.link || "",
        access: [...((data?.access as any[]) || [])],
      };
    });
  }

  /**
   * Fetch bookmarks (search, filter, etc)
   * Raindrop.io API: GET /raindrops/{collectionId} or /raindrops/0
   */
  async getBookmarks(
    params: {
      search?: string;
      collection?: number;
      tags?: string[];
      important?: boolean;
      page?: number;
      perPage?: number;
      sort?: string;
      tag?: string;
      duplicates?: boolean;
      broken?: boolean;
      notag?: boolean;
      highlight?: boolean;
      domain?: string;
      createdStart?: string;
      createdEnd?: string;
      media?: string;
    } = {},
    skipCache = false,
  ): Promise<{ items: Bookmark[]; count: number }> {
    // The upstream list endpoint uses 0-based pagination and caps pages at 50.
    if (params.page !== undefined &&
      (!Number.isSafeInteger(params.page) || params.page < 0)) {
      throw new ValidationError("page must be a non-negative integer");
    }
    if (params.perPage !== undefined &&
      (!Number.isSafeInteger(params.perPage) || params.perPage < 1 || params.perPage > 50)) {
      throw new ValidationError("perPage must be an integer between 1 and 50");
    }
    if (params.collection !== undefined &&
      (!Number.isSafeInteger(params.collection) ||
       !([0, -1, -99].includes(params.collection) || params.collection > 0))) {
      throw new ValidationError("Invalid collection ID for bookmark search");
    }

    // Generate cache key from sorted params
    const cacheKey = JSON.stringify(
      Object.keys(params)
        .sort()
        .reduce((obj: any, key) => {
          obj[key] = (params as any)[key];
          return obj;
        }, {}),
    );

    if (!skipCache) {
      const cached = await this.cacheSearch.get(cacheKey);
      if (cached) {
        this.logger.debug("Cache HIT: getBookmarks");
        return cached as { items: Bookmark[]; count: number };
      }
    }

    this.logger.debug("Cache MISS: getBookmarks");
    const result = await this.withRateLimit(async () => {
      const query: any = {};
      const searchParts = params.search ? [params.search] : [];

      // GET /raindrops/{collectionId} documents search, sort, page, perpage
      // and nested, not independent tag/domain query parameters.
      const tagSearch = (tag: string) =>
        "#" + (tag.includes(" ") ? JSON.stringify(tag) : tag);
      for (const tag of params.tags ?? []) searchParts.push(tagSearch(tag));
      if (params.tag) searchParts.push(tagSearch(params.tag));
      if (params.important === true) searchParts.push("❤️");
      if (params.important === false) searchParts.push("-❤️");
      if (params.page !== undefined) query.page = params.page;
      if (params.perPage !== undefined) query.perpage = params.perPage;
      if (params.sort) query.sort = params.sort;

      if (params.duplicates === true) {
        searchParts.push("duplicate:true");
      }
      if (params.broken === true) {
        searchParts.push("broken:true");
      }
      if (params.notag === true) {
        searchParts.push("notag:true");
      }
      if (params.highlight === true) {
        searchParts.push("highlights:true");
      }

      if (params.createdStart) {
        searchParts.push(`created:>=${params.createdStart}`);
      }
      if (params.createdEnd) {
        searchParts.push(`created:<=${params.createdEnd}`);
      }
      if (params.media) {
        searchParts.push(`type:${params.media}`);
      }

      if (params.domain) searchParts.push(`link:${params.domain}`);
      if (searchParts.length > 0) {
        query.search = searchParts.join(" ");
      }
      const endpoint = params.collection ? "/raindrops/{id}" : "/raindrops/0";
      const options = params.collection
        ? { params: { path: { id: params.collection }, query } }
        : { params: { query } };

      const { data } = await (this.client as any).GET(endpoint, options);
      return {
        items: (data?.items as Bookmark[]) || [],
        count: data?.count || 0,
      };
    });

    this.cacheSearch.set(cacheKey, result);
    return result;
  }

  /**
   * Read only the officially reported filter counts for an explicit scope.
   * Missing statistics are omitted; an unknown count must not become zero.
   * Official API: GET /filters/{collectionId}.
   */
  async getBookmarkFilters(
    collectionId = 0,
    tagsSort?: "-count" | "_id",
    search?: string,
  ): Promise<{
    broken?: number;
    duplicates?: number;
    important?: number;
    notag?: number;
    tags?: Array<{ name: string; count: number }>;
    types?: Array<{ name: string; count: number }>;
  }> {
    if (!Number.isSafeInteger(collectionId) || collectionId < 0) {
      throw new ValidationError("filters collectionId must be 0 or a positive integer");
    }
    return this.withRateLimit(async () => {
      const query: { tagsSort?: string; search?: string } = {};
      if (tagsSort !== undefined) query.tagsSort = tagsSort;
      if (search !== undefined) query.search = search;
      const { data, error } = await (this.client as any).GET(
        "/filters/{collectionId}",
        { params: { path: { collectionId }, query } },
      );
      if (error || !data || data.result !== true) {
        throw new UpstreamError("Raindrop filter statistics could not be verified");
      }

      const stats: {
        broken?: number; duplicates?: number; important?: number; notag?: number;
        tags?: Array<{ name: string; count: number }>;
        types?: Array<{ name: string; count: number }>;
      } = {};
      for (const key of ["broken", "duplicates", "important", "notag"] as const) {
        if (data[key] === undefined) continue;
        const count = data[key]?.count;
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new UpstreamError(`Raindrop filter ${key} count was invalid`);
        }
        stats[key] = count;
      }
      for (const key of ["tags", "types"] as const) {
        if (data[key] === undefined) continue;
        if (!Array.isArray(data[key])) {
          throw new UpstreamError(`Raindrop filter ${key} was invalid`);
        }
        stats[key] = data[key].map((item: any) => {
          if (typeof item?._id !== "string" ||
              !Number.isSafeInteger(item.count) || item.count < 0) {
            throw new UpstreamError(`Raindrop filter ${key} entry was invalid`);
          }
          return { name: item._id, count: item.count as number };
        });
      }
      return stats;
    });
  }

  /**
   * Read-only URL existence check. Raindrop's endpoint is a POST, but it does
   * not mutate bookmarks and may use the bounded read retry policy.
   * Official API: POST /import/url/exists, body { urls: [url] }.
   *
   * The generated local schema does not yet describe this official endpoint,
   * so it is called through the existing centralized client, not a second fetch
   * implementation. Do not infer a per-URL mapping from aggregate ids.
   */
  async bookmarkExists(url: string): Promise<{ exists: boolean; ids: number[] }> {
    return this.withRateLimit(async () => {
      const { data, error } = await (this.client as any).POST(
        "/import/url/exists",
        { body: { urls: [url] } },
      );
      if (error || !data || typeof data !== "object") {
        throw new UpstreamError("URL existence response was not verified");
      }

      const body = data as { result?: unknown; ids?: unknown };
      if (
        typeof body.result !== "boolean" ||
        !Array.isArray(body.ids) ||
        !body.ids.every(
          (id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
        ) ||
        body.result !== (body.ids.length > 0)
      ) {
        throw new UpstreamError("Invalid URL existence response from Raindrop");
      }

      return { exists: body.result, ids: body.ids as number[] };
    }, "read");
  }

  /** Strict, uncached official duplicate-filter scope; deliberately capped at 50. */
  async getDuplicateScope(collectionId: number): Promise<number[]> {
    if (!Number.isSafeInteger(collectionId) || collectionId <= 0)
      throw new ValidationError("Positive actual collectionId required");
    await this.withRateLimit(async () => {
      const { data } = await this.client.GET("/collection/{id}", {
        params: { path: { id: collectionId } },
      });
      if (data?.result !== true || data.item?._id !== collectionId)
        throw new ValidationError("Duplicate source collection inaccessible or invalid");
    });
    const pageSchema = z.object({
      result: z.literal(true), count: z.number().int().nonnegative().max(50),
      items: z.array(z.object({ _id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })),
    });
    const readPage = async (page: number) => this.withRateLimit(async () => {
      // Local generated path typing uses id; the official placeholder is collectionId.
      const options = { params: { path: { id: collectionId, collectionId }, query: {
        search: "duplicate:true", page, perpage: 50, nested: false,
      } } };
      const { data } = await this.client.GET("/raindrops/{collectionId}", options);
      const parsed = pageSchema.safeParse(data);
      if (!parsed.success) throw new ValidationError("Invalid official duplicate snapshot or scope exceeds 50 filtered results");
      return parsed.data;
    });
    const first = await readPage(0);
    const ids = first.items.map(item => item._id);
    if (ids.length !== first.count || new Set(ids).size !== ids.length)
      throw new ValidationError("Incomplete or overlapping duplicate snapshot");
    // An independent terminal page must agree with count and have no overlap/items.
    const terminal = await readPage(1);
    if (terminal.count !== first.count || terminal.items.length !== 0)
      throw new ValidationError("Duplicate pagination changed or pages overlap");
    return ids.sort((a, b) => a - b);
  }

  /** Fresh raw metadata: missing deletion fields remain unknown, never defaults. */
  async getDuplicateMetadata(id: number, collectionId: number) {
    return this.withRateLimit(async () => {
      const { data } = await this.client.GET("/raindrop/{id}", {
        params: { path: { id } },
      });
      const parsed = z.object({ result: z.literal(true), item: z.object({
        _id: z.literal(id), collection: z.object({ $id: z.literal(collectionId) }),
        link: z.string().min(1),
      }).passthrough() }).safeParse(data);
      if (!parsed.success) throw new ValidationError("Cannot verify fresh duplicate identity, URL or source membership");
      return parsed.data.item;
    });
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
    return this.withRateLimit(async () => {
      if (typeof target === "number") {
        const { data } = await this.client.GET("/raindrop/{id}/suggest", {
          params: { path: { id: target } },
        });
        return data as components["schemas"]["SuggestionsResponse"];
      } else {
        const { data } = await this.client.POST("/raindrop/suggest", {
          body: { link: target },
        });
        return data as components["schemas"]["SuggestionsResponse"];
      }
    });
  }

  /**
   * Create a new bookmark
   * Raindrop.io API: POST /raindrop
   */
  async createBookmark(
    collectionId: number | undefined,
    bookmark: {
      link: string;
      title?: string;
      excerpt?: string;
      note?: string;
      tags?: string[];
      important?: boolean;
    },
  ): Promise<Bookmark> {
    if (!bookmark.link)
      throw new ValidationError("Bookmark link is required");
    if (collectionId !== undefined &&
        (!Number.isSafeInteger(collectionId) || collectionId <= 0))
      throw new ValidationError("Invalid destination collection ID");
    const newBookmark = await this.withWriteRateLimit(async () => {
      const { data, error } = await this.client.POST("/raindrop", {
        body: {
          link: bookmark.link,
          ...(bookmark.title !== undefined ? { title: bookmark.title } : {}),
          ...(bookmark.excerpt !== undefined ? { excerpt: bookmark.excerpt } : {}),
          ...(bookmark.note !== undefined ? { note: bookmark.note } : {}),
          ...(bookmark.tags !== undefined ? { tags: bookmark.tags } : {}),
          // Generated local schema requires a creation default; explicit
          // false remains false and does not affect other saved bookmarks.
          important: bookmark.important ?? false,
          ...(collectionId !== undefined ? { collection: { $id: collectionId } } : {}),
        },
      });
      if (error || data?.result !== true ||
          !Number.isSafeInteger(data?.item?._id) ||
          (data?.item?._id ?? 0) <= 0)
        throw new UpstreamError("Bookmark creation outcome could not be verified");
      return data.item as Bookmark;
    });

    // Invalidate search cache (since a new item might affect search results)
    await this.cacheSearch.clear();
    return newBookmark;
  }

  /**
   * Update a bookmark
   * Raindrop.io API: PUT /raindrop/{id}
   */
  async updateBookmark(
    id: number,
    updates: Partial<Bookmark>,
  ): Promise<Bookmark> {
    const updated = await this.withWriteRateLimit(async () => {
      const { data, error } = await this.client.PUT("/raindrop/{id}", {
        params: { path: { id } },
        body: updates,
      });
      if (error || data?.result !== true || data?.item?._id !== id)
        throw new UpstreamError("Bookmark update outcome could not be verified");
      return data.item as Bookmark;
    });

    // Invalidate bookmark and search caches
    await this.cacheBookmarks.delete(`id:${id}`);
    await this.cacheSearch.clear();
    return updated;
  }

  /**
   * Delete a bookmark
   * Raindrop.io API: DELETE /raindrops/{collectionId} with ids:[id].
   * Unscoped single-item DELETE could permanently delete after a Trash race.
   */
  async deleteBookmark(id: number, sourceCollectionId: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0 ||
        !Number.isSafeInteger(sourceCollectionId) ||
        (sourceCollectionId !== -1 && sourceCollectionId !== -99 && sourceCollectionId <= 0))
      throw new ValidationError("Exact positive bookmark ID and explicit source collection required");

    // Check the original source again inside the Service. Even if another client
    // moves it after this GET, the collection-scoped DELETE can no longer turn
    // an ordinary Trash move into a permanent single-item deletion.
    const current = await this.getBookmark(id, true);
    if (current._id !== id || current.collection?.$id !== sourceCollectionId)
      throw new ValidationError("Bookmark source changed; nothing deleted");

    try {
      await this.withWriteRateLimit(async () => {
        // Official: DELETE /raindrops/{collectionId} with exact IDs.
        // Source -99 is deliberately explicit for permanent deletion.
        // Generated OpenAPI types misname this path variable and omit
        // nested/modified; the runtime endpoint follows the official API.
        const { data } = await (this.client as any).DELETE("/raindrops/{collectionId}", {
          params: {
            path: { collectionId: sourceCollectionId },
            query: { nested: false },
          },
          body: { ids: [id] },
        });
        // One supplied ID makes a reported single modification attributable.
        // Any aggregate/missing acknowledgement is NOT a verified deletion.
        if (!z.object({ result: z.literal(true), modified: z.literal(1) }).safeParse(data).success)
          throw new UnknownWriteError(
            "Scoped bookmark deletion was not individually acknowledged; inspect upstream before retrying",
          );
      });
    } finally {
      // Unknown results can still have mutated upstream state.
      this.cacheBookmarks.delete(`id:${id}`);
      this.cacheSearch.clear();
      this.cacheCollections.clear();
    }
  }

  async updateBookmarkBatch(
    input: z.infer<typeof BookmarkBatchUpdateInputSchema>,
  ): Promise<BookmarkBatchOutcome> {
    const parsed = BookmarkBatchUpdateInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ValidationError("Invalid bookmark batch update", parsed.error);
    const {
      collectionId,
      ids,
      tagsToAdd,
      clearTags,
      destinationCollectionId,
      important,
    } = parsed.data;
    return this.mutateBookmarkBatch(collectionId, ids, {
      ...(tagsToAdd !== undefined ? { tags: tagsToAdd } : {}),
      ...(clearTags === true ? { tags: [] } : {}),
      ...(destinationCollectionId !== undefined
        ? { collection: { $id: destinationCollectionId } }
        : {}),
      ...(important !== undefined ? { important } : {}),
    });
  }

  async deleteBookmarkBatch(
    input: z.infer<typeof BookmarkBatchDeleteInputSchema>,
  ): Promise<BookmarkBatchOutcome> {
    const parsed = BookmarkBatchDeleteInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ValidationError("Invalid bookmark batch delete", parsed.error);
    return this.mutateBookmarkBatch(parsed.data.collectionId, parsed.data.ids);
  }

  /**
   * https://developer.raindrop.io/v1/raindrops/multiple
   * Fresh membership checks, then exactly one official collection-scoped write.
   * The aggregate acknowledgement cannot establish individual ID outcomes.
   */
  private async mutateBookmarkBatch(
    collectionId: number,
    ids: number[],
    updates?: {
      tags?: string[];
      collection?: { $id: number };
      important?: boolean;
    },
  ): Promise<BookmarkBatchOutcome> {
    const outcome = (
      status: "failed" | "unknown",
      reason: string,
      dispatched: boolean,
      acknowledged = false,
      modified?: number,
    ): BookmarkBatchOutcome => ({
      status,
      reason,
      dispatched,
      acknowledged,
      ...(modified !== undefined ? { modified } : {}),
      succeeded: [],
      failed: dispatched && status === "failed" ? [...ids] : [],
      unknown: status === "unknown" ? [...ids] : [],
      notExecuted: !dispatched ? [...ids] : [],
    });
    try {
      // Deliberately bypass getBookmark/getCollection caches and validate raw
      // acknowledgement, identity and membership; a cached item is insufficient.
      for (const id of ids) {
        await this.withRateLimit(async () => {
          const { data } = await this.client.GET("/raindrop/{id}", {
            params: { path: { id } },
          });
          if (
            data?.result !== true ||
            data.item?._id !== id ||
            data.item?.collection?.$id !== collectionId
          ) {
            throw new ValidationError(
              `Bookmark ${id} preflight cannot verify membership in source collection ${collectionId}`,
            );
          }
        });
      }
      if (updates?.collection) {
        const targetId = updates.collection.$id;
        await this.withRateLimit(async () => {
          const { data } = await this.client.GET("/collection/{id}", {
            params: { path: { id: targetId } },
          });
          if (data?.result !== true || data.item?._id !== targetId)
            throw new ValidationError(
              `Destination collection ${targetId} preflight failed`,
            );
        });
      }
      // Retries consume the same Service HTTP budget. Leave the write entirely
      // undispatched if preflight exhausted it; there is no readback loop.
      if (this.upstreamRequestCount >= 60)
        throw new ValidationError(
          "Per-invocation upstream request budget of 60 exhausted before batch write",
        );
    } catch (error) {
      return outcome(
        "failed",
        `Batch preflight failed; no write dispatched: ${error instanceof Error ? error.message : "invalid response"}`,
        false,
      );
    }

    return this.withWriteRateLimit(async () => {
      let data: unknown;
      try {
        // The generated schema calls this path parameter id. Supply its typed
        // placeholder too; openapi-fetch interpolates only collectionId in the
        // official URL. Neither parameter becomes a query or body field.
        const options = {
          params: { path: { collectionId, id: collectionId } },
          body: { ids, ...updates },
        };
        const response =
          updates === undefined
            ? await this.client.DELETE("/raindrops/{collectionId}", options)
            : await this.client.PUT("/raindrops/{collectionId}", options);
        data = response.data;
      } catch (error) {
        const status =
          error instanceof UpstreamError
            ? (error.cause as { status?: number } | undefined)?.status
            : undefined;
        const rejected =
          error instanceof AuthError ||
          error instanceof NotFoundError ||
          error instanceof ValidationError ||
          status === 400 ||
          status === 422;
        return outcome(
          rejected ? "failed" : "unknown",
          `Batch write ${rejected ? "rejected" : "outcome unknown"}: ${error instanceof Error ? error.message : "no acknowledgement"}. Do not automatically retry.`,
          true,
        );
      } finally {
        // Even a lost response may have mutated upstream state.
        this.cacheBookmarks.clear();
        this.cacheSearch.clear();
        this.cacheCollections.clear();
      }
      const ack = z
        .object({
          result: z.boolean(),
          modified: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .optional(),
        })
        .safeParse(data);
      if (z.object({ result: z.literal(false) }).safeParse(data).success)
        return outcome(
          "failed",
          "Raindrop rejected the batch write (result:false); do not automatically retry.",
          true,
        );
      // No per-ID attribution, including when modified equals ids.length:
      // official docs do not define it as proof of every requested change.
      return outcome(
        "unknown",
        "Batch per-ID outcomes unknown; aggregate acknowledgement does not identify modified IDs. Inspect current bookmarks before deciding whether to retry; do not automatically retry.",
        true,
        ack.success && ack.data.result === true,
        ack.success ? ack.data.modified : undefined,
      );
    });
  }

  /**
   * Batch update bookmarks
   * Raindrop.io API: PUT /raindrops
   */
  async batchUpdateBookmarks(
    ids: number[],
    updates: {
      tags?: string[];
      collection?: number;
      important?: boolean;
      broken?: boolean;
    },
  ): Promise<boolean> {
    return this.withWriteRateLimit(async () => {
      const body: any = { ids };
      if (updates.tags) body.tags = updates.tags;
      if (updates.collection) body.collection = { $id: updates.collection };
      if (updates.important !== undefined) body.important = updates.important;
      if (updates.broken !== undefined) body.broken = updates.broken;
      const { data } = await this.client.PUT("/raindrops", { body });

      // Invalidate caches
      await this.cacheSearch.clear();
      for (const id of ids) {
        await this.cacheBookmarks.delete(`id:${id}`);
      }

      return !!data?.result;
    });
  }

  /**
   * Batch update bookmarks in a specific collection
   * Raindrop.io API: PUT /raindrops/{collectionId}
   */
  async batchUpdateBookmarksInCollection(
    collectionId: number,
    updates: {
      ids: number[];
      tags?: string[];
      important?: boolean;
      broken?: boolean;
    },
  ): Promise<boolean> {
    return this.withWriteRateLimit(async () => {
      const { data } = await this.client.PUT("/raindrops/{collectionId}", {
        params: { path: { id: collectionId } as any },
        body: updates,
      });

      // Invalidate caches
      await this.cacheSearch.clear();
      if (updates.ids) {
        for (const id of updates.ids) {
          await this.cacheBookmarks.delete(`id:${id}`);
        }
      }

      return !!(data as any)?.result;
    });
  }

  /**
   * Batch delete bookmarks in a specific collection or empty trash
   * Raindrop.io API: DELETE /raindrops/{collectionId}
   */
  async batchDeleteBookmarksInCollection(
    collectionId: number,
    ids?: number[],
  ): Promise<boolean> {
    return this.withWriteRateLimit(async () => {
      const { data } = await this.client.DELETE("/raindrops/{collectionId}", {
        params: { path: { id: collectionId } as any },
        body: ids ? { ids } : undefined,
      });

      // Invalidate caches
      await this.cacheSearch.clear();
      if (ids) {
        for (const id of ids) {
          await this.cacheBookmarks.delete(`id:${id}`);
        }
      } else {
        await this.cacheBookmarks.clear();
      }

      return !!(data as any)?.result;
    });
  }

  /** Legacy service entry point also fails closed. */
  async emptyTrash(): Promise<boolean> {
    throw new ValidationError(
      "Legacy empty_trash disabled; use trash_empty preview/confirm",
    );
  }

  async emptyTrashPreviewFirst(
    input: z.infer<typeof TrashEmptyInputSchema>,
  ): Promise<TrashEmptyOutcome> {
    const args = TrashEmptyInputSchema.parse(input);
    const confirming = "confirm" in args;
    const reserveWrite = confirming ? 1 : 0;
    const budget = (remainingReads: number) => {
      if (this.upstreamRequestCount + remainingReads + reserveWrite > 60)
        throw new ValidationError(
          "Complete Trash enumeration exceeds remaining 60 HTTP attempt budget; use bookmark_delete permanent:true with explicit limited IDs",
        );
    };
    const pageSchema = z.object({
      result: z.literal(true),
      count: z.number().int().nonnegative().safe(),
      items: z.array(z.object({ _id: z.number().int().positive().safe() })),
    });
    const read = (page: number, remainingReads: number) =>
      this.withRateLimit(async () => {
        // Recheck planning on retries too; keep all remaining pages and the write feasible.
        budget(remainingReads);
        const { data } = await this.client.GET("/raindrops/{collectionId}", {
          params: {
            path: { id: -99, collectionId: -99 },
            query: { page, perpage: 50, nested: false },
          },
        });
        const parsed = pageSchema.safeParse(data);
        if (!parsed.success)
          throw new ValidationError(
            "Invalid Trash page: require result:true, reliable count and positive safe IDs",
          );
        return parsed.data;
      });
    let snapshot: { total: number; ids: number[]; digest: string };
    try {
      const first = await read(0, 1);
      const total = first.count;
      const pages = Math.ceil(total / 50);
      // Page zero itself is the terminal empty page for an empty Trash.
      budget(pages === 0 ? 0 : pages);
      const ids: number[] = [];
      const seen = new Set<number>();
      const accept = (data: z.infer<typeof pageSchema>, page: number) => {
        const expectedLength =
          page < pages ? Math.min(50, total - page * 50) : 0;
        if (data.count !== total || data.items.length !== expectedLength)
          throw new ValidationError(
            "Trash count drift or incomplete pagination",
          );
        for (const item of data.items) {
          if (seen.has(item._id))
            throw new ValidationError(
              "Overlapping Trash pages or duplicate ID",
            );
          seen.add(item._id);
          ids.push(item._id);
        }
      };
      accept(first, 0);
      for (let page = 1; page <= pages; page++)
        accept(await read(page, pages - page + 1), page);
      if (ids.length !== total)
        throw new ValidationError("Trash membership count mismatch");
      ids.sort((a, b) => a - b);
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify({ version: 1, collectionId: -99, total, ids }),
        ),
      );
      const digest = `trash-v1:sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      snapshot = { total, ids, digest };
    } catch (error) {
      return {
        status: "notExecuted",
        collectionId: -99,
        reason: `No write attempted: ${error instanceof Error ? error.message : "Trash verification failed"}`,
      };
    }
    const outcome = (
      status: TrashEmptyOutcome["status"],
      reason: string,
    ): TrashEmptyOutcome => ({
      status,
      collectionId: -99,
      ...snapshot,
      reason,
    });
    if (!("confirm" in args))
      return outcome(
        "preview",
        "Complete Trash preview; nothing deleted. Confirm with collectionId:-99, expectedTotal and digest. Digest is not a transaction lock.",
      );
    if (
      args.expectedTotal !== snapshot.total ||
      args.digest !== snapshot.digest
    )
      return outcome(
        "notExecuted",
        "Trash confirmation mismatch; nothing deleted. Request a new preview.",
      );
    if (snapshot.total === 0)
      return outcome(
        "notExecuted",
        "Trash is already empty; no write attempted.",
      );
    // Planning above reserves this single write, including any read retries.
    return this.withWriteRateLimit(async () => {
      let status: "succeeded" | "failed" | "unknown" = "unknown";
      try {
        const { data } = await this.client.DELETE("/collection/{id}", {
          params: { path: { id: -99 } },
        });
        const ack = z.object({ result: z.boolean() }).safeParse(data);
        if (ack.success) status = ack.data.result ? "succeeded" : "failed";
      } catch (error) {
        const httpStatus =
          error instanceof UpstreamError
            ? (error.cause as { status?: number } | undefined)?.status
            : undefined;
        if (
          error instanceof AuthError ||
          error instanceof NotFoundError ||
          (httpStatus !== undefined && [400, 422].includes(httpStatus))
        )
          status = "failed";
      }
      if (status !== "failed") {
        this.cacheCollections.clear();
        this.cacheBookmarks.clear();
        this.cacheSearch.clear();
      }
      return outcome(
        status,
        status === "succeeded"
          ? "Irreversible Trash emptying acknowledged by Raindrop."
          : status === "failed"
            ? "Raindrop rejected Trash emptying."
            : "Trash write outcome unknown; never blindly retry. No rollback is claimed; inspect upstream state.",
      );
    });
  }

  /**
   * Remove all empty collections
   * Raindrop.io API: PUT /collections/clean
   */
  async removeEmptyCollections(): Promise<boolean> {
    return this.withWriteRateLimit(async () => {
      const { data } = await this.client.PUT("/collections/clean");

      // Invalidate collections cache
      await this.cacheCollections.clear();

      return !!(data as any)?.result;
    });
  }

  private tagScope(collectionId?: number): number {
    const parsed = TagScopeSchema.safeParse(
      collectionId === undefined ? 0 : collectionId,
    );
    if (!parsed.success)
      throw new ValidationError(
        "collectionId must be a nonnegative safe integer",
      );
    return parsed.data;
  }

  /** Always fetch current scoped tags; mutation preflights must not use a cache. */
  async getTags(
    collectionId?: number,
  ): Promise<{ _id: string; count: number }[]> {
    const scope = this.tagScope(collectionId);
    return this.withRateLimit(async () => {
      // The generated upstream schema incorrectly calls this path parameter `id`.
      const { data } = await (this.client as any).GET("/tags/{collectionId}", {
        params: { path: { collectionId: scope } },
      });
      if (
        data?.result !== true ||
        !Array.isArray(data.items) ||
        !data.items.every(
          (tag: { _id?: unknown; count?: unknown }) =>
            tag &&
            typeof tag._id === "string" &&
            TagNameSchema.safeParse(tag._id).success &&
            typeof tag.count === "number" &&
            Number.isSafeInteger(tag.count) &&
            tag.count >= 0,
        ) ||
        new Set(data.items.map((tag: { _id: string }) => tag._id)).size !==
          data.items.length
      ) {
        throw new UpstreamError(
          "Invalid tag list from Raindrop; preflight cannot establish current tags",
        );
      }
      return data.items;
    });
  }

  async getTagsByCollection(
    collectionId: number,
  ): Promise<{ _id: string; count: number }[]> {
    return this.getTags(collectionId);
  }

  private async mutateTags(
    operation: "rename" | "merge" | "delete",
    collectionId: number | undefined,
    tags: string[],
    replacement?: string,
  ): Promise<boolean> {
    const scope = this.tagScope(collectionId);
    if (!TagNamesSchema.safeParse(tags).success) {
      throw new ValidationError(
        "Provide explicit nonempty distinct tag names without surrounding whitespace",
      );
    }
    if (operation !== "delete") {
      if (
        !TagNameSchema.safeParse(replacement).success ||
        tags.includes(replacement!)
      ) {
        throw new ValidationError(
          "Replacement must be a nonempty name distinct from every source",
        );
      }
      if (
        (operation === "rename" && tags.length !== 1) ||
        (operation === "merge" && tags.length < 2)
      ) {
        throw new ValidationError(
          "Rename requires exactly one source; merge requires at least two distinct sources",
        );
      }
    }
    const existing = new Set((await this.getTags(scope)).map((tag) => tag._id));
    for (const tag of tags) {
      if (!existing.has(tag))
        throw new ValidationError(
          `Tag ${JSON.stringify(tag)} does not exist in scope ${scope}`,
        );
    }
    if (operation === "rename" && existing.has(replacement!)) {
      throw new ValidationError(
        "Target tag already exists; use tag_merge instead",
      );
    }

    return this.withWriteRateLimit(async () => {
      let data;
      try {
        const options = {
          params: { path: { collectionId: scope } },
          body:
            operation === "delete" ? { tags } : { tags, replace: replacement },
        };
        // Official tags/replace contract differs from the generated upstream schema.
        const response =
          operation === "delete"
            ? await (this.client as any).DELETE("/tags/{collectionId}", options)
            : await (this.client as any).PUT("/tags/{collectionId}", options);
        data = response.data;
      } catch (error) {
        if (
          error instanceof RateLimitError ||
          error instanceof AuthError ||
          error instanceof NotFoundError ||
          error instanceof ValidationError
        )
          throw error;
        throw new UnknownWriteError(
          "Tag write result unknown; inspect current tags before deciding whether to retry",
          error,
        );
      }
      if (data?.result === false) return false;
      if (data?.result !== true) {
        throw new UnknownWriteError(
          "Tag write result unknown: upstream did not confirm result:true; do not automatically retry",
        );
      }
      this.cacheSearch.clear();
      this.cacheBookmarks.clear();
      return true;
    });
  }

  async deleteTags(
    collectionId: number | undefined,
    tags: string[],
  ): Promise<boolean> {
    return this.mutateTags("delete", collectionId, tags);
  }

  async renameTag(
    collectionId: number | undefined,
    oldName: string,
    newName: string,
  ): Promise<boolean> {
    return this.mutateTags("rename", collectionId, [oldName], newName);
  }

  async mergeTags(
    collectionId: number | undefined,
    tags: string[],
    newName: string,
  ): Promise<boolean> {
    return this.mutateTags("merge", collectionId, tags, newName);
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
   * Raindrop.io API: GET /user/stats, /collections, and /tags/0
   */
  async getUserStats(): Promise<
    components["schemas"]["UserStatsResponse"]["stats"]
  > {
    return this.withRateLimit(async () => {
      // 1. Get system counts from /user/stats (bookmarks, trash)
      const statsResponse = await this.client.GET("/user/stats");
      const statsData = statsResponse.data as any;

      // 2. Get collection count from /collections
      const collectionsResponse = await this.client.GET("/collections");

      // 3. Get tag count from /tags/0
      const tagsResponse = await this.client.GET("/tags/0");

      const items = statsData?.items || [];
      const totalBookmarks = items.find((i: any) => i._id === 0)?.count || 0;
      const trashCount = items.find((i: any) => i._id === -99)?.count || 0;

      return {
        bookmarks: totalBookmarks,
        trash: trashCount,
        collections: collectionsResponse.data?.items?.length || 0,
        highlights: 0, // No direct total highlights count available
        tags: tagsResponse.data?.items?.length || 0,
      };
    });
  }

  /** Fresh owner-checked GET for listing and every highlight mutation preflight. */
  async getHighlights(bookmarkId: number): Promise<HighlightRecord[]> {
    if (!HighlightBookmarkIdSchema.safeParse(bookmarkId).success)
      throw new ValidationError("bookmarkId must be a positive safe integer");
    return this.withRateLimit(async () => {
      const { data } = await this.client.GET("/raindrop/{id}", {
        params: { path: { id: bookmarkId } },
      });
      const parsed = this.parseHighlightBookmark(data, bookmarkId);
      if (!parsed) throw new UpstreamError("Invalid highlight bookmark response; preflight cannot verify owner or highlights");
      return parsed;
    });
  }

  private parseHighlightBookmark(data: unknown, bookmarkId: number): HighlightRecord[] | undefined {
    const parsed = z.object({
      result: z.literal(true),
      item: z.object({ _id: z.literal(bookmarkId), highlights: z.array(HighlightRecordSchema) }),
    }).safeParse(data);
    if (!parsed.success) return undefined;
    const highlights = parsed.data.item.highlights;
    if (new Set(highlights.map(h => h._id)).size !== highlights.length) return undefined;
    return highlights;
  }

  /**
   * Fetch all highlights across all bookmarks
   * Raindrop.io API: GET /raindrops/0
   */
  async getAllHighlights(): Promise<Highlight[]> {
    return this.withRateLimit(async () => {
      const { data } = await this.client.GET("/raindrops/0");
      const items = (data as any)?.items || [];
      return items.flatMap((bookmark: any) =>
        Array.isArray(bookmark.highlights) ? bookmark.highlights : [],
      );
    });
  }

  /** Official targeted patches: never replay a write or submit the full snapshot. */
  private async mutateHighlight(
    operation: "create" | "update" | "delete",
    bookmarkId: number,
    highlightId: string | undefined,
    fields: z.infer<typeof HighlightUpdateFieldsSchema>,
  ): Promise<HighlightWriteOutcome> {
    if (operation !== "create" && !HighlightIdSchema.safeParse(highlightId).success)
      throw new ValidationError("highlightId must be a nonempty string without surrounding whitespace");
    const before = await this.getHighlights(bookmarkId);
    const previous = before.find(h => h._id === highlightId);
    if (operation !== "create" && !previous)
      throw new NotFoundError(`Highlight ${highlightId} not found in bookmark ${bookmarkId}`);
    const patch = operation === "create" ? fields
      : operation === "delete" ? { _id: highlightId!, text: "" }
      : { _id: highlightId!, ...fields };
    const unknown = (): HighlightWriteOutcome => ({
      status: "unknown", bookmarkId,
      ...(highlightId !== undefined ? { highlightId } : {}),
      reason: "Highlight write result unknown; inspect current highlights before deciding whether to retry. Do not automatically retry.",
    });
    return this.withWriteRateLimit(async () => {
      let data: unknown;
      try {
        // Local generated schema omits the official partial highlights patch.
        // Keep that discrepancy within this adapter; each request has one patch.
        const response = await this.client.PUT("/raindrop/{id}", {
          params: { path: { id: bookmarkId } },
          body: { highlights: [patch] } as components["schemas"]["UpdateBookmarkRequest"],
        }).finally(() => {
          // A dispatched write may have succeeded even when its response is
          // missing or malformed. Never serve a stale cached bookmark then.
          this.cacheBookmarks.delete(`id:${bookmarkId}`);
          this.cacheSearch.clear();
        });
        data = response.data;
      } catch (error) {
        if (error instanceof AuthError || error instanceof NotFoundError ||
            error instanceof RateLimitError || error instanceof ValidationError) throw error;
        return unknown();
      }
      if (data && typeof data === "object" && "result" in data && data.result === false)
        throw new UpstreamError("Raindrop rejected the highlight write (result:false)");
      const after = this.parseHighlightBookmark(data, bookmarkId);
      if (!after) return unknown();
      // Confirm unaffected highlights retain every original field (timestamps may advance).
      const unchanged = (old: HighlightRecord, current: HighlightRecord | undefined) =>
        current !== undefined && Object.entries(old).every(([key, value]) =>
          key === "lastUpdate" || JSON.stringify(current[key]) === JSON.stringify(value));
      if (!before.filter(h => h._id !== highlightId).every(h => unchanged(h, after.find(a => a._id === h._id))))
        return unknown();
      let target: HighlightRecord | undefined;
      if (operation === "create") {
        const oldIds = new Set(before.map(h => h._id));
        const added = after.filter(h => !oldIds.has(h._id));
        if (added.length !== 1) return unknown();
        target = added[0];
      } else {
        target = after.find(h => h._id === highlightId);
      }
      if (operation === "delete") {
        if (target) return unknown();
      } else {
        if (!target || !Object.entries(fields).every(([key, value]) => value === undefined || target![key] === value))
          return unknown();
        if (previous && !Object.entries(previous).every(([key, value]) =>
          key === "lastUpdate" || (key in fields && fields[key as keyof typeof fields] !== undefined) || JSON.stringify(target![key]) === JSON.stringify(value)))
          return unknown();
      }
      return {
        status: "succeeded", bookmarkId, highlightId: target?._id ?? highlightId!,
        highlight: target ?? null, deleted: operation === "delete",
      };
    });
  }

  async createHighlight(bookmarkId: number, fields: z.infer<typeof HighlightCreateFieldsSchema>): Promise<HighlightWriteOutcome> {
    const parsed = HighlightCreateFieldsSchema.safeParse(fields);
    if (!parsed.success) throw new ValidationError("Invalid highlight creation fields", parsed.error);
    return this.mutateHighlight("create", bookmarkId, undefined, parsed.data);
  }

  async updateHighlight(bookmarkId: number, highlightId: string, fields: z.infer<typeof HighlightUpdateFieldsSchema>): Promise<HighlightWriteOutcome> {
    const parsed = HighlightUpdateFieldsSchema.safeParse(fields);
    if (!parsed.success) throw new ValidationError("Invalid highlight update fields; provide at least one field", parsed.error);
    return this.mutateHighlight("update", bookmarkId, highlightId, parsed.data);
  }

  async deleteHighlight(bookmarkId: number, highlightId: string): Promise<HighlightWriteOutcome> {
    return this.mutateHighlight("delete", bookmarkId, highlightId, {});
  }
}
