import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient } from "../../src/ima.ts";
import { RefreshingImaNotes } from "../../src/exporting-notes.ts";
import {
  MAX_IMAGE_REFRESH_BATCH_SIZE,
  processImageRefreshBatch,
  type ImageRefreshBatchRequest,
  type ImageRefreshBatchResult,
} from "../../src/note-image-resign.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch, type MockFetchHandler } from "../helpers/mock-fetch.ts";

const credentials: ImaCredentials = {
  clientId: "test_client_id",
  apiKey: "test_api_key",
};

const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php";

function setupExportFetch(handler: MockFetchHandler) {
  const uploaded: File[] = [];
  const mock = setupMockFetch((request) => {
    if (request.url === LITTERBOX_API) {
      const file = (request.body as FormData).get("fileToUpload");
      assert.ok(file instanceof File);
      assert.strictEqual((request.body as FormData).get("time"), "24h");
      uploaded.push(file);
      return new Response("https://litter.catbox.moe/mock-note.md", { status: 200 });
    }
    return handler(request);
  });
  return { ...mock, uploaded };
}

function createShardNamespace(
  handler: (request: ImageRefreshBatchRequest, index: number) => Promise<ImageRefreshBatchResult[]> | ImageRefreshBatchResult[],
) {
  const batches: ImageRefreshBatchRequest[] = [];
  let nextId = 0;
  return {
    batches,
    namespace: {
      newUniqueId() {
        nextId += 1;
        return { toString: () => `shard-${nextId}` };
      },
      get() {
        return {
          async processBatch(request: ImageRefreshBatchRequest) {
            batches.push(request);
            return handler(request, batches.length - 1);
          },
        };
      },
    } as any,
  };
}

function envForExport(shard?: ReturnType<typeof createShardNamespace>["namespace"]): Env {
  return {
    IMA_BASE_URL: "https://ima.qq.com",
    ...(shard ? { IMA_IMAGE_REFRESH_SHARD: shard } : {}),
  };
}

function bareEnv(): Env {
  return { IMA_BASE_URL: "https://ima.qq.com" };
}

function imaUrl(path: string, start: number, end: number, signature: string) {
  return `https://ima-notebook-prod.image.myqcloud.com${path}?q-sign-algorithm=sha1&q-ak=test&q-sign-time=${start}%3B${end}&q-key-time=${start}%3B${end}&q-header-list=&q-url-param-list=&q-signature=${signature}`;
}


function mediaInfoResponse(url: string) {
  return new Response(JSON.stringify({ code: 0, data: { media_type: 9, url_info: { url } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function format2Response(entries: Array<{ mediaId: string; cosKey: string }>) {
  return new Response(JSON.stringify({
    code: 0,
    data: {
      content: JSON.stringify(entries.map((entry) => ({ type: "cloud_image", ...entry }))),
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("note export preserves a reachable legacy image without media metadata", async () => {
  const path = "/2/user/legacy-readable";
  const url = `https://ima-notebook-prod.image.myqcloud.com${path}`;
  const { namespace, batches } = createShardNamespace((request) =>
    processImageRefreshBatch(bareEnv(), credentials, request.items));
  let headCalls = 0;
  let mediaCalls = 0;
  const { restore, uploaded } = setupExportFetch((req) => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      return new Response(JSON.stringify({ code: 0, data: { content: `# Legacy\n![img](${url})` } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) {
      // Production legacy image nodes contain a URL but no cosKey/mediaId.
      return new Response(JSON.stringify({
        code: 0, data: { content: JSON.stringify([{ type: "cloud_image", url }]) },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (req.method === "HEAD" && req.url === url) {
      headCalls++;
      return new Response(null, { status: 200 });
    }
    if (req.url.endsWith("get_media_info")) mediaCalls++;
    return new Response("Not found", { status: 404 });
  });

  try {
    const notes = new RefreshingImaNotes(new ImaClient(envForExport(namespace), credentials));
    const result = await notes.exportNote("note_legacy_reachable");
    assert.equal(result.expires_in, "24h");
    assert.equal(headCalls, 1);
    assert.equal(mediaCalls, 0);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].items[0].mode, "probe_only");
    assert.equal(batches[0].items[0].mediaId, "");
    assert.equal(uploaded.length, 1);
    assert.match(await uploaded[0].text(), /legacy-readable/);
  } finally {
    restore();
  }
});

test("note export fails before public upload if an unsigned legacy image is inaccessible", async () => {
  const path = "/2/user/legacy-unavailable";
  const url = `https://ima-notebook-prod.image.myqcloud.com${path}`;
  const { namespace } = createShardNamespace((request) =>
    processImageRefreshBatch(bareEnv(), credentials, request.items));
  let headCalls = 0;
  const { restore, uploaded } = setupExportFetch((req) => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      return new Response(JSON.stringify({ code: 0, data: { content: `![img](${url})` } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) {
      return new Response(JSON.stringify({
        code: 0, data: { content: JSON.stringify([{ type: "cloud_image", url }]) },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (req.method === "HEAD" && req.url === url) {
      headCalls++;
      return new Response(null, { status: 403 });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const notes = new RefreshingImaNotes(new ImaClient(envForExport(namespace), credentials));
    await assert.rejects(
      () => notes.exportNote("note_legacy_unavailable"),
      /原链接不可访问且 format=2 缺少 mediaId/,
    );
    assert.equal(headCalls, 1);
    assert.equal(uploaded.length, 0);
  } finally {
    restore();
  }
});

test("expired legacy images with missing mediaId fail before any HEAD probe or public upload", async () => {
  const url = imaUrl("/2/user/expired-but-head200", 1, 2, "already-expired");
  let headCalls = 0;
  let shardCalls = 0;
  const { namespace } = createShardNamespace(() => {
    shardCalls++;
    return [];
  });
  const { restore, uploaded } = setupExportFetch((req) => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      return new Response(JSON.stringify({ code: 0, data: { content: `![img](${url})` } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) {
      return new Response(JSON.stringify({
        code: 0, data: { content: JSON.stringify([{ type: "cloud_image", url }]) },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (req.method === "HEAD" && req.url === url) {
      headCalls++;
      return new Response(null, { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const notes = new RefreshingImaNotes(new ImaClient(envForExport(namespace), credentials));
    await assert.rejects(
      () => notes.exportNote("note_expired_no_media"),
      /原签名已过期且 format=2 缺少 mediaId/,
    );
    assert.equal(headCalls, 0);
    assert.equal(shardCalls, 0);
    assert.equal(uploaded.length, 0);
  } finally {
    restore();
  }
});

test("DO rejects probe_only for a signed legacy URL without making a HEAD request", async () => {
  const url = imaUrl("/2/user/forged-probe", 1, 2, "expired");
  let headCalls = 0;
  const { restore } = setupMockFetch((req) => {
    if (req.method === "HEAD") headCalls++;
    return new Response(null, { status: 200 });
  });
  try {
    await assert.rejects(
      () => processImageRefreshBatch(bareEnv(), credentials, [
        { sourceUrl: url, mediaId: "", mode: "probe_only" },
      ]),
      /有签名的图片不能使用 probe_only 模式/,
    );
    assert.equal(headCalls, 0);
  } finally {
    restore();
  }
});

test("note export keeps fresh signatures without format=2 or shard RPC", async () => {
    const url = imaUrl("/2/user/hash-fresh", 4_102_444_800, 4_102_473_600, "fresh-existing");
  const { restore, captured, uploaded } = setupExportFetch((req) => {
    if (req.url.endsWith("get_doc_content")) {
      assert.strictEqual(req.body.target_content_format, 1);
      return new Response(JSON.stringify({ code: 0, data: { content: `# Note\n\n![img](${url})` } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const notes = new RefreshingImaNotes(new ImaClient(envForExport(), credentials));
    await notes.exportNote("note_fresh");
    assert.strictEqual(captured.filter((x) => x.url.endsWith("get_doc_content")).length, 1);
    assert.match(await uploaded[0].text(), /fresh-existing/);
  } finally {
    restore();
  }
});

test("note export partitions 112 expired images into 13 bounded shard batches", async () => {
    const entries = Array.from({ length: 112 }, (_, index) => {
    const path = `/2/user/hash-${index}`;
    return {
      path,
      mediaId: `media_${index}`,
      oldUrl: imaUrl(path, 1, 2, `old-${index}`),
      freshUrl: imaUrl(path, 4_102_444_800, 4_102_473_600, `fresh-${index}`),
    };
  });
  const { namespace, batches } = createShardNamespace((request) => request.items.map((item) => {
    const entry = entries.find((candidate) => candidate.mediaId === item.mediaId);
    assert.ok(entry);
    return { sourceUrl: item.sourceUrl, freshUrl: entry.freshUrl, preserved: false };
  }));

  const { restore, captured, uploaded } = setupExportFetch((req) => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      const markdown = entries.map((entry) => `![img](${entry.oldUrl})`).join("\n");
      return new Response(JSON.stringify({ code: 0, data: { content: markdown } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) {
      return format2Response(entries.map((entry) => ({ mediaId: entry.mediaId, cosKey: entry.path })));
    }
    return new Response("unexpected main-worker fetch", { status: 599 });
  });

  try {
    const notes = new RefreshingImaNotes(new ImaClient(envForExport(namespace), credentials));
    await notes.exportNote("note_large");
    assert.strictEqual(batches.length, 13);
    assert.deepStrictEqual(batches.map((batch) => batch.items.length), [...Array(12).fill(9), 4]);
    assert.ok(batches.every((batch) => batch.items.length <= MAX_IMAGE_REFRESH_BATCH_SIZE));
    assert.strictEqual(captured.filter((x) => x.url !== LITTERBOX_API).length, 2);
    assert.strictEqual(captured.filter((x) => x.method === "HEAD").length, 0);
    assert.strictEqual(captured.filter((x) => x.url.endsWith("get_media_info")).length, 0);
  } finally {
    restore();
  }
});

test("note export deduplicates repeated images and only replaces image destinations", async () => {
    const path = "/2/user/hash-scoped";
  const expired = imaUrl(path, 1, 2, "old-scoped");
  const refreshed = imaUrl(path, 4_102_444_800, 4_102_473_600, "new-scoped");
  const { namespace, batches } = createShardNamespace((request) => [
    { sourceUrl: request.items[0].sourceUrl, freshUrl: refreshed, preserved: false },
  ]);

  const { restore, uploaded } = setupExportFetch((req) => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      return new Response(JSON.stringify({
        code: 0,
        data: { content: `![a](${expired})\n![b](${expired})\n[link](${expired})` },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) {
      return format2Response([{ mediaId: "media_scoped", cosKey: path }]);
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const notes = new RefreshingImaNotes(new ImaClient(envForExport(namespace), credentials));
    await notes.exportNote("note_scoped");
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].items.length, 1);
    const text = await uploaded[0].text();
    assert.strictEqual(text.split(refreshed).length - 1, 2);
    assert.ok(text.includes(`[link](${expired})`));
  } finally {
    restore();
  }
});

test("note export fails before temporary upload when a shard fails", async () => {
    const path = "/2/user/hash-fail";
  const expired = imaUrl(path, 1, 2, "old-fail");
  const { namespace } = createShardNamespace(() => {
    throw new Error("shard failed");
  });

  const { restore, uploaded } = setupExportFetch((req) => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      return new Response(JSON.stringify({ code: 0, data: { content: `![img](${expired})` } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) {
      return format2Response([{ mediaId: "media_fail", cosKey: path }]);
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const notes = new RefreshingImaNotes(new ImaClient(envForExport(namespace), credentials));
    await assert.rejects(() => notes.exportNote("note_fail"), /shard failed/);
    assert.strictEqual(uploaded.length, 0);
  } finally {
    restore();
  }
});

test("image shard rejects batches over 9 before any network request", async () => {
  let fetchCalls = 0;
  const { restore, uploaded } = setupExportFetch(() => {
    fetchCalls += 1;
    return new Response("unexpected", { status: 500 });
  });

  try {
    const items = Array.from({ length: 10 }, (_, index) => ({
      sourceUrl: imaUrl(`/2/user/too-many-${index}`, 1, 2, `old-${index}`),
      mediaId: `media_${index}`,
      mode: "refresh" as const,
    }));
    await assert.rejects(() => processImageRefreshBatch(bareEnv(), credentials, items), /批次过大/);
    assert.strictEqual(fetchCalls, 0);
  } finally {
    restore();
  }
});

test("image shard refreshes and HEAD-validates a known-expired image", async () => {
  const path = "/2/user/hash-expired";
  const sourceUrl = imaUrl(path, 1, 2, "old");
  const freshUrl = imaUrl(path, 4_102_444_800, 4_102_473_600, "fresh");
  let mediaCalls = 0;
  let headCalls = 0;
  const { restore, uploaded } = setupExportFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      mediaCalls += 1;
      assert.deepStrictEqual(req.body, { media_id: "media_1" });
      return mediaInfoResponse(freshUrl);
    }
    if (req.method === "HEAD" && req.url === freshUrl) {
      headCalls += 1;
      return new Response(null, { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const result = await processImageRefreshBatch(bareEnv(), credentials, [
      { sourceUrl, mediaId: "media_1", mode: "refresh" },
    ]);
    assert.strictEqual(mediaCalls, 1);
    assert.strictEqual(headCalls, 1);
    assert.deepStrictEqual(result, [{ sourceUrl, freshUrl, preserved: false }]);
  } finally {
    restore();
  }
});

test("image shard preserves an unparseable signature when old URL still works", async () => {
  const sourceUrl = "https://ima-notebook-prod.image.myqcloud.com/2/user/hash-probe?q-signature=unknown";
  let mediaCalls = 0;
  const { restore, uploaded } = setupExportFetch((req) => {
    if (req.method === "HEAD" && req.url === sourceUrl) return new Response(null, { status: 200 });
    if (req.url.endsWith("get_media_info")) mediaCalls += 1;
    return new Response("Not found", { status: 404 });
  });

  try {
    const result = await processImageRefreshBatch(bareEnv(), credentials, [
      { sourceUrl, mediaId: "media_probe", mode: "probe" },
    ]);
    assert.strictEqual(mediaCalls, 0);
    assert.deepStrictEqual(result, [{ sourceUrl, preserved: true }]);
  } finally {
    restore();
  }
});

test("worst-case nine-item shard stays at 45 external fetches", async () => {
  const items = Array.from({ length: 9 }, (_, index) => ({
    sourceUrl: `https://ima-notebook-prod.image.myqcloud.com/2/user/worst-${index}?q-signature=unknown`,
    mediaId: `media_${index}`,
    mode: "probe" as const,
  }));
  const attempts = new Map<string, number>();
  let fetchCalls = 0;
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void) => { fn(); return 0; };
  const { restore, uploaded } = setupExportFetch((req) => {
    fetchCalls += 1;
    if (req.method === "HEAD" && req.url.includes("q-signature=unknown")) {
      return new Response(null, { status: 403 });
    }
    if (req.url.endsWith("get_media_info")) {
      const mediaId = req.body.media_id as string;
      const attempt = (attempts.get(mediaId) ?? 0) + 1;
      attempts.set(mediaId, attempt);
      if (attempt < 3) {
        return new Response(JSON.stringify({ code: 200001, msg: "rate limited", data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const index = Number(mediaId.replace("media_", ""));
      return mediaInfoResponse(imaUrl(`/2/user/worst-${index}`, 4_102_444_800, 4_102_473_600, `fresh-${index}`));
    }
    if (req.method === "HEAD" && req.url.includes("q-sign-time=")) {
      return new Response(null, { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const results = await processImageRefreshBatch(bareEnv(), credentials, items);
    assert.strictEqual(results.length, 9);
    assert.strictEqual(fetchCalls, 45);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});
