import test from "node:test";
import assert from "node:assert/strict";
import { WeReadClient, WEREAD_SKILL_VERSION } from "../.selftest-build/weread-client.js";
import { WeReadError } from "../.selftest-build/errors.js";
import {
  normalizeBookNotes,
  normalizeBookshelf,
  normalizeNotebooks,
  normalizePublicReviews,
  normalizeSearch,
} from "../.selftest-build/normalize.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

test("WeReadClient flattens params and sends skill_version", async () => {
  let seen;
  const client = new WeReadClient({
    apiKey: "wrk-test",
    fetchImpl: async (_url, init) => {
      seen = init;
      return jsonResponse({ ok: 1 });
    },
  });
  await client.call("/user/notebooks", { count: 20, lastSort: 123 });
  const body = JSON.parse(seen.body);
  assert.deepEqual(body, {
    api_name: "/user/notebooks",
    count: 20,
    lastSort: 123,
    skill_version: WEREAD_SKILL_VERSION,
  });
  assert.equal(body.params, undefined);
  assert.equal(seen.headers.Authorization, "Bearer wrk-test");
});

test("business params cannot override api_name or skill_version", async () => {
  let seen;
  const client = new WeReadClient({
    apiKey: "wrk-test",
    fetchImpl: async (_url, init) => {
      seen = JSON.parse(init.body);
      return jsonResponse({ ok: 1 });
    },
  });
  await client.call("/shelf/sync", { api_name: "/_list", skill_version: "evil" });
  assert.equal(seen.api_name, "/shelf/sync");
  assert.equal(seen.skill_version, WEREAD_SKILL_VERSION);
});

test("WeReadClient fails closed on upgrade_info", async () => {
  const client = new WeReadClient({
    apiKey: "wrk-test",
    fetchImpl: async () => jsonResponse({ upgrade_info: { version: "1.0.5" } }),
  });
  await assert.rejects(
    client.call("/shelf/sync"),
    (error) => error instanceof WeReadError && error.code === "WEREAD_SKILL_UPGRADE_REQUIRED",
  );
});

test("429 is not retried and preserves Retry-After", async () => {
  let calls = 0;
  const client = new WeReadClient({
    apiKey: "wrk-test",
    fetchImpl: async () => {
      calls += 1;
      return new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });
    },
  });
  await assert.rejects(
    client.call("/shelf/sync"),
    (error) =>
      error instanceof WeReadError &&
      error.code === "WEREAD_RATE_LIMITED" &&
      error.details?.retryAfter === "60",
  );
  assert.equal(calls, 1);
});

test("503 is retried only once", async () => {
  let calls = 0;
  const client = new WeReadClient({
    apiKey: "wrk-test",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? new Response("bad", { status: 503 }) : jsonResponse({ books: [] });
    },
  });
  await client.call("/shelf/sync");
  assert.equal(calls, 2);
});

test("bookshelf count includes books, albums and mp", () => {
  assert.equal(
    normalizeBookshelf({ books: [{}, {}], albums: [{}], mp: { name: "文章收藏" } }).visibleItemCount,
    4,
  );
});

test("notebook total and lastSort continuation preserve official semantics", () => {
  const result = normalizeNotebooks({
    totalBookCount: 2,
    totalNoteCount: 12,
    hasMore: 1,
    books: [
      { sort: 200, reviewCount: 1, noteCount: 2, bookmarkCount: 3 },
      { sort: 100, reviewCount: 2, noteCount: 1, bookmarkCount: 3 },
    ],
  });
  assert.equal(result.books[0].totalNoteCount, 6);
  assert.deepEqual(result.continuation, { lastSort: 100 });
});

test("search continuation comes from nested last searchIdx", () => {
  const result = normalizeSearch({
    sid: "abc",
    hasMore: 1,
    results: [
      { title: "电子书", books: [{ searchIdx: 1 }, { searchIdx: 3 }] },
      { title: "作者", books: [{ searchIdx: 7 }] },
    ],
  });
  assert.deepEqual(result.continuation, { maxIdx: 7 });
});

test("personal notes combine highlights and thoughts without inventing bookmarks", () => {
  const result = normalizeBookNotes(
    { updated: [{ bookmarkId: "h1", type: 1 }], chapters: [{ chapterUid: 1 }] },
    { reviews: [{ review: { content: "thought" } }], totalCount: 3, hasMore: 1, synckey: 99 },
  );
  assert.equal(result.highlights.length, 1);
  assert.equal(result.thoughts.length, 1);
  assert.equal("bookmarks" in result, false);
  assert.deepEqual(result.continuation, { synckey: 99 });
});

test("public review continuation uses reviewsHasMore, last idx and synckey", () => {
  const result = normalizePublicReviews({
    reviewsHasMore: 1,
    synckey: 88,
    reviews: [{ idx: 1 }, { idx: 4 }],
  });
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.continuation, { maxIdx: 4, synckey: 88 });
});
