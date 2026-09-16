import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { WeReadClient } from "./weread-client.js";
import { toSafeError } from "./errors.js";
import {
  normalizeBookNotes,
  normalizeBookshelf,
  normalizeHighlightThoughts,
  normalizeNotebooks,
  normalizePopularHighlights,
  normalizePublicReviews,
  normalizeRecommendations,
  normalizeSearch,
} from "./normalize.js";

export interface Env {
  WEREAD_API_KEY: string;
}

const UnknownObject = z.record(z.string(), z.unknown());
const ErrorDetails = z.object({
  httpStatus: z.number().optional(),
  retryAfter: z.string().optional(),
  upstreamCode: z.union([z.number(), z.string()]).optional(),
  upgradeInfo: z.unknown().optional(),
});
const ErrorOutput = z.object({
  code: z.enum([
    "WEREAD_AUTH_FAILED",
    "WEREAD_RATE_LIMITED",
    "WEREAD_BAD_REQUEST",
    "WEREAD_NOT_FOUND",
    "WEREAD_TIMEOUT",
    "WEREAD_UPSTREAM_ERROR",
    "WEREAD_SKILL_UPGRADE_REQUIRED",
  ]),
  message: z.string(),
  details: ErrorDetails.optional(),
});

const annotations = { readOnlyHint: true } as const;

function toolResult<T extends object>(data: T) {
  const structuredContent = { ok: true as const, data };
  return {
    content: [{ type: "text" as const, text: "结果已作为 structuredContent 返回。" }],
    structuredContent,
  };
}

function toolError(error: unknown) {
  const safe = toSafeError(error);
  const structuredContent = { ok: false as const, error: safe };
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${safe.code}: ${safe.message}` }],
    structuredContent,
  };
}

function resultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: ErrorOutput }),
  ]);
}

async function safeCall<T extends object>(fn: () => Promise<T>) {
  try {
    return toolResult(await fn());
  } catch (error) {
    return toolError(error);
  }
}

export function createServer(env: Env) {
  const server = new McpServer({ name: "weread-mcp", version: "1.0.0" });
  const client = new WeReadClient({ apiKey: env.WEREAD_API_KEY });

  server.registerTool(
    "weread_search",
    {
      title: "搜索微信读书",
      description: "按关键词搜索微信读书内容；返回候选，不自动选择同名书。",
      annotations,
      inputSchema: z.object({
        keyword: z.string().min(1),
        scope: z.union([z.literal(0), z.literal(10), z.literal(16), z.literal(14), z.literal(6), z.literal(12), z.literal(13), z.literal(2), z.literal(4)]),
        count: z.number().int().positive().optional(),
        continuation: z.object({ maxIdx: z.number().int() }).optional(),
      }),
      outputSchema: resultSchema(
        z.object({
          sid: z.string().optional(),
          groups: z.unknown(),
          hasMore: z.boolean(),
          continuation: z.object({ maxIdx: z.number() }).optional(),
        }),
      ),
    },
    async ({ keyword, scope, count, continuation }) =>
      safeCall(async () => {
        const payload = await client.call("/store/search", {
          keyword,
          scope,
          ...(count == null ? {} : { count }),
          ...(continuation?.maxIdx == null ? {} : { maxIdx: continuation.maxIdx }),
        });
        return normalizeSearch(payload);
      }),
  );

  server.registerTool(
    "weread_get_bookshelf",
    {
      title: "获取微信读书书架",
      description: "获取电子书、有声书/专辑及文章收藏，并计算可见书架条目数。",
      annotations,
      inputSchema: z.object({}),
      outputSchema: resultSchema(
        z.object({
          books: z.array(z.unknown()),
          albums: z.array(z.unknown()),
          mp: z.unknown().nullable(),
          visibleItemCount: z.number().int().nonnegative(),
        }),
      ),
    },
    async () => safeCall(async () => normalizeBookshelf(await client.call("/shelf/sync"))),
  );

  server.registerTool(
    "weread_get_book",
    {
      title: "获取微信读书书籍信息",
      description: "按 bookId 获取书籍详情、章节目录或当前用户阅读进度。",
      annotations,
      inputSchema: z.object({
        bookId: z.string().min(1),
        view: z.enum(["info", "chapters", "progress"]),
      }),
      outputSchema: resultSchema(z.object({ view: z.string(), bookId: z.string(), result: UnknownObject })),
    },
    async ({ bookId, view }) =>
      safeCall(async () => {
        const apiName =
          view === "info" ? "/book/info" : view === "chapters" ? "/book/chapterinfo" : "/book/getprogress";
        const result = await client.call(apiName, { bookId });
        return { view, bookId, result };
      }),
  );

  server.registerTool(
    "weread_get_notebooks",
    {
      title: "获取微信读书笔记本概览",
      description: "获取有个人笔记的书籍概览；分页使用 lastSort。",
      annotations,
      inputSchema: z.object({
        count: z.number().int().positive().optional(),
        continuation: z.object({ lastSort: z.number().int() }).optional(),
      }),
      outputSchema: resultSchema(
        z.object({
          totalBookCount: z.number().optional(),
          totalNoteCount: z.number().optional(),
          books: z.array(z.unknown()),
          hasMore: z.boolean(),
          continuation: z.object({ lastSort: z.number() }).optional(),
        }),
      ),
    },
    async ({ count, continuation }) =>
      safeCall(async () => {
        const payload = await client.call("/user/notebooks", {
          ...(count == null ? {} : { count }),
          ...(continuation?.lastSort == null ? {} : { lastSort: continuation.lastSort }),
        });
        return normalizeNotebooks(payload);
      }),
  );

  server.registerTool(
    "weread_get_book_notes",
    {
      title: "获取单本书个人笔记",
      description: "同时获取个人划线与个人想法/点评；书签只统计数量，当前官方接口不导出书签内容。",
      annotations,
      inputSchema: z.object({
        bookId: z.string().min(1),
        count: z.number().int().positive().optional(),
        continuation: z.object({ synckey: z.number().int() }).optional(),
      }),
      outputSchema: resultSchema(
        z.object({
          book: z.unknown().nullable(),
          chapters: z.array(z.unknown()),
          highlightsIncluded: z.boolean(),
          highlights: z.array(z.unknown()),
          thoughts: z.array(z.unknown()),
          totalThoughtCount: z.number().optional(),
          hasMore: z.boolean(),
          continuation: z.object({ synckey: z.number() }).optional(),
        }),
      ),
    },
    async ({ bookId, count, continuation }) =>
      safeCall(async () => {
        const highlightsIncluded = continuation?.synckey == null;
        const thoughtsPromise = client.call("/review/list/mine", {
          bookid: bookId,
          ...(count == null ? {} : { count }),
          ...(continuation?.synckey == null ? {} : { synckey: continuation.synckey }),
        });
        const highlightsPromise = highlightsIncluded
          ? client.call("/book/bookmarklist", { bookId })
          : Promise.resolve({});
        const [highlights, thoughts] = await Promise.all([highlightsPromise, thoughtsPromise]);
        return { highlightsIncluded, ...normalizeBookNotes(highlights, thoughts) };
      }),
  );

  server.registerTool(
    "weread_get_popular_highlights",
    {
      title: "获取热门划线",
      description: "获取一本书或指定章节的热门划线；该接口不伪造分页。",
      annotations,
      inputSchema: z.object({
        bookId: z.string().min(1),
        chapterUid: z.number().int().optional(),
      }),
      outputSchema: resultSchema(
        z.object({
          synckey: z.number().optional(),
          totalCount: z.number().optional(),
          chapters: z.array(z.unknown()),
          highlights: z.array(z.unknown()),
        }),
      ),
    },
    async ({ bookId, chapterUid }) =>
      safeCall(async () =>
        normalizePopularHighlights(
          await client.call("/book/bestbookmarks", {
            bookId,
            ...(chapterUid == null ? {} : { chapterUid }),
          }),
        ),
      ),
  );

  const highlightRangeInput = z.object({
    range: z.string().min(1),
    count: z.number().int().positive().max(20).optional(),
    maxIdx: z.number().int().optional(),
    synckey: z.number().int().optional(),
  });

  server.registerTool(
    "weread_get_highlight_thoughts",
    {
      title: "获取热门划线下的想法",
      description: "按一个或多个划线 range 获取公开想法，并保留每个 range 自己的分页状态。",
      annotations,
      inputSchema: z.object({
        bookId: z.string().min(1),
        chapterUid: z.number().int(),
        reviews: z.array(highlightRangeInput).min(1),
      }),
      outputSchema: resultSchema(
        z.object({
          bookId: z.string().optional(),
          chapterUid: z.number().optional(),
          reviews: z.array(z.unknown()),
        }),
      ),
    },
    async ({ bookId, chapterUid, reviews }) =>
      safeCall(async () =>
        normalizeHighlightThoughts(await client.call("/book/readreviews", { bookId, chapterUid, reviews })),
      ),
  );

  server.registerTool(
    "weread_get_reading_stats",
    {
      title: "获取阅读统计",
      description: "获取周、月、年或累计阅读统计；时长单位按官方接口保留为秒。",
      annotations,
      inputSchema: z.object({
        mode: z.enum(["weekly", "monthly", "annually", "overall"]),
        baseTime: z.number().int().optional(),
      }),
      outputSchema: resultSchema(z.object({ mode: z.string(), result: UnknownObject })),
    },
    async ({ mode, baseTime }) =>
      safeCall(async () => ({
        mode,
        result: await client.call("/readdata/detail", {
          mode,
          ...(baseTime == null ? {} : { baseTime }),
        }),
      })),
  );

  server.registerTool(
    "weread_get_public_reviews",
    {
      title: "获取公开点评",
      description: "获取一本书的公开点评；与用户自己的个人笔记严格区分。",
      annotations,
      inputSchema: z.object({
        bookId: z.string().min(1),
        reviewListType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
        count: z.number().int().positive().optional(),
        continuation: z.object({ maxIdx: z.number().int().optional(), synckey: z.number().int().optional() }).optional(),
      }),
      outputSchema: resultSchema(
        z.object({
          reviews: z.array(z.unknown()),
          reviewsCnt: z.number().optional(),
          recentTotalCnt: z.number().optional(),
          friendCommentCount: z.number().optional(),
          hasMore: z.boolean(),
          continuation: z.object({ maxIdx: z.number().optional(), synckey: z.number().optional() }).optional(),
        }),
      ),
    },
    async ({ bookId, reviewListType, count, continuation }) =>
      safeCall(async () =>
        normalizePublicReviews(
          await client.call("/review/list", {
            bookId,
            ...(reviewListType == null ? {} : { reviewListType }),
            ...(count == null ? {} : { count }),
            ...(continuation?.maxIdx == null ? {} : { maxIdx: continuation.maxIdx }),
            ...(continuation?.synckey == null ? {} : { synckey: continuation.synckey }),
          }),
        ),
      ),
  );

  server.registerTool(
    "weread_get_recommendations",
    {
      title: "获取微信读书推荐",
      description: "获取个性化推荐或某本书的相似推荐，并保留真实 maxIdx/sessionId 分页语义。",
      annotations,
      inputSchema: z.object({
        mode: z.enum(["personalized", "similar"]),
        bookId: z.string().min(1).optional(),
        count: z.number().int().positive().optional(),
        continuation: z.object({ maxIdx: z.number().int().optional(), sessionId: z.string().optional() }).optional(),
      }).superRefine((value, ctx) => {
        if (value.mode === "similar" && !value.bookId) {
          ctx.addIssue({ code: "custom", message: "similar 模式必须提供 bookId", path: ["bookId"] });
        }
      }),
      outputSchema: resultSchema(
        z.object({
          mode: z.enum(["personalized", "similar"]),
          books: z.array(z.unknown()),
          hasMore: z.boolean().optional(),
          continuation: z.object({ maxIdx: z.number().optional(), sessionId: z.string().optional() }).optional(),
        }),
      ),
    },
    async ({ mode, bookId, count, continuation }) =>
      safeCall(async () => {
        if (mode === "personalized") {
          const payload = await client.call("/book/recommend", {
            ...(count == null ? {} : { count }),
            ...(continuation?.maxIdx == null ? {} : { maxIdx: continuation.maxIdx }),
          });
          return normalizeRecommendations(mode, payload);
        }

        const effectiveCount = count ?? 12;
        const effectiveMaxIdx = continuation?.maxIdx ?? 0;
        const payload = await client.call("/book/similar", {
          bookId,
          count: effectiveCount,
          maxIdx: effectiveMaxIdx,
          ...(continuation?.sessionId == null ? {} : { sessionId: continuation.sessionId }),
        });
        return normalizeRecommendations(mode, payload);
      }),
  );

  return server;
}
