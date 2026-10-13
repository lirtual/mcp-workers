import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient } from "../../src/ima.ts";
import { RefreshingImaNotes } from "../../src/exporting-notes.ts";
import { MAX_IMAGE_REFRESH_BATCH_SIZE, processImageRefreshBatch } from "../../src/note-image-resign.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch, type MockFetchHandler } from "../helpers/mock-fetch.ts";

const credentials: ImaCredentials = { clientId: "test_client_id", apiKey: "test_api_key" };
const env: Env = { IMA_BASE_URL: "https://ima.qq.com" };
const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php";

function imageUrl(path: string, expired: boolean, signature = "sig") {
  const start = expired ? 1 : 4_102_444_800;
  const end = expired ? 2 : 4_102_473_600;
  return `https://ima-notebook-prod.image.myqcloud.com${path}?q-sign-time=${start}%3B${end}&q-signature=${signature}`;
}

function imaResponse(data: unknown) {
  return new Response(JSON.stringify({ code: 0, data }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}
function format2(entries: Array<{ mediaId: string; cosKey: string }>) {
  return imaResponse({ content: JSON.stringify(entries.map(entry => ({ type: "cloud_image", ...entry }))) });
}
function withUploads(handler: MockFetchHandler) {
  const uploaded: File[] = [];
  const mock = setupMockFetch(req => {
    if (req.url === LITTERBOX_API) {
      const form = req.body as FormData;
      assert.equal(form.get("reqtype"), "fileupload");
      assert.equal(form.get("time"), "24h");
      const file = form.get("fileToUpload");
      assert.ok(file instanceof File);
      uploaded.push(file);
      return new Response("https://litter.catbox.moe/test-export.md");
    }
    return handler(req);
  });
  return { ...mock, uploaded };
}
function makeNotes() { return new RefreshingImaNotes(new ImaClient(env, credentials)); }

test("fresh signatures export without format=2 or image refresh requests", async () => {
  const url = imageUrl("/2/user/fresh", false);
  const { restore, captured, uploaded } = withUploads(req => {
    if (req.url.endsWith("get_doc_content")) {
      assert.equal(req.body.target_content_format, 1);
      return imaResponse({ content: `# Note\n![img](${url})` });
    }
    return new Response("unexpected fetch", { status: 500 });
  });
  try {
    await makeNotes().exportNote("fresh");
    assert.equal(captured.filter(req => req.url.endsWith("get_doc_content")).length, 1);
    assert.equal(captured.filter(req => req.url.endsWith("get_media_info")).length, 0);
    assert.equal(uploaded.length, 1);
    assert.match(await uploaded[0].text(), /q-signature=sig/);
  } finally { restore(); }
});

test("expired images are refreshed directly and duplicate Markdown images share one request", async () => {
  const path = "/2/user/expired";
  const old = imageUrl(path, true);
  const fresh = imageUrl(path, false, "new");
  let mediaCalls = 0;
  let headCalls = 0;
  const { restore, uploaded } = withUploads(req => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      return imaResponse({ content: `![a](${old})\n![b](${old})\n[link](${old})` });
    }
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) {
      return format2([{ mediaId: "media_1", cosKey: path }]);
    }
    if (req.url.endsWith("get_media_info")) {
      mediaCalls++;
      assert.deepEqual(req.body, { media_id: "media_1" });
      return imaResponse({ url_info: { url: fresh } });
    }
    if (req.method === "HEAD" && req.url === fresh) {
      headCalls++;
      return new Response(null, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  try {
    await makeNotes().exportNote("expired");
    assert.equal(mediaCalls, 1);
    assert.equal(headCalls, 1);
    assert.equal(uploaded.length, 1);
    const markdown = await uploaded[0].text();
    assert.equal(markdown.split(fresh).length - 1, 2);
    assert.ok(markdown.includes(`[link](${old})`));
  } finally { restore(); }
});

test("8 expired images can be refreshed within a bounded number of external requests", async () => {
  const entries = Array.from({ length: MAX_IMAGE_REFRESH_BATCH_SIZE }, (_, index) => ({
    path: `/2/user/bounded-${index}`, mediaId: `media_${index}`,
  }));
  let mediaCalls = 0;
  const { restore, captured, uploaded } = withUploads(req => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      return imaResponse({ content: entries.map(e => `![img](${imageUrl(e.path, true)})`).join("\n") });
    }
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) {
      return format2(entries.map(e => ({ cosKey: e.path, mediaId: e.mediaId })));
    }
    if (req.url.endsWith("get_media_info")) {
      mediaCalls++;
      const id = req.body.media_id as string;
      const entry = entries.find(e => e.mediaId === id);
      assert.ok(entry);
      return imaResponse({ url_info: { url: imageUrl(entry.path, false) } });
    }
    if (req.method === "HEAD") return new Response(null, { status: 200 });
    return new Response("unexpected", { status: 500 });
  });
  try {
    await makeNotes().exportNote("bounded");
    assert.equal(mediaCalls, MAX_IMAGE_REFRESH_BATCH_SIZE);
    assert.equal(uploaded.length, 1);
    assert.equal(captured.length, 2 + MAX_IMAGE_REFRESH_BATCH_SIZE * 2 + 1);
  } finally { restore(); }
});

test("9 expired images fail before requesting format=2 or uploading to third party", async () => {
  const images = Array.from({ length: MAX_IMAGE_REFRESH_BATCH_SIZE + 1 }, (_, index) =>
    `![img](${imageUrl(`/2/user/overflow-${index}`, true)})`).join("\n");
  const { restore, captured, uploaded } = withUploads(req => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      return imaResponse({ content: images });
    }
    return new Response("unexpected", { status: 500 });
  });
  try {
    await assert.rejects(() => makeNotes().exportNote("overflow"), /单次导出最多支持 8 张/);
    assert.equal(captured.length, 1);
    assert.equal(uploaded.length, 0);
  } finally { restore(); }
});

test("probe preserves still-accessible images without refreshing media", async () => {
  const path = "/2/user/probe";
  const raw = "https://ima-notebook-prod.image.myqcloud.com" + path + "?q-signature=unknown";
  let refreshed = 0;
  const { restore, uploaded } = withUploads(req => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) return imaResponse({ content: `![img](${raw})` });
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) return format2([{ mediaId: "probe", cosKey: path }]);
    if (req.method === "HEAD" && req.url === raw) return new Response(null, { status: 200 });
    if (req.url.endsWith("get_media_info")) refreshed++;
    return new Response("unexpected", { status: 500 });
  });
  try {
    await makeNotes().exportNote("probe");
    assert.equal(refreshed, 0);
    assert.equal(uploaded.length, 1);
    assert.ok((await uploaded[0].text()).includes(raw));
  } finally { restore(); }
});

test("missing image metadata fails without external upload", async () => {
  const old = imageUrl("/2/user/missing", true);
  const { restore, uploaded } = withUploads(req => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) return imaResponse({ content: `![img](${old})` });
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) return format2([]);
    return new Response("unexpected", { status: 500 });
  });
  try {
    await assert.rejects(() => makeNotes().exportNote("missing"), /未找到.*mediaId/);
    assert.equal(uploaded.length, 0);
  } finally { restore(); }
});

test("invalid refreshed URL fails without uploading an invalid document", async () => {
  const path = "/2/user/bad";
  const old = imageUrl(path, true);
  const { restore, uploaded } = withUploads(req => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) return imaResponse({ content: `![img](${old})` });
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) return format2([{ mediaId: "bad", cosKey: path }]);
    if (req.url.endsWith("get_media_info")) return imaResponse({ url_info: { url: imageUrl("/2/user/other", false) } });
    return new Response("unexpected", { status: 500 });
  });
  try {
    await assert.rejects(() => makeNotes().exportNote("bad"), /未返回.*可用新签名/);
    assert.equal(uploaded.length, 0);
  } finally { restore(); }
});

test("inline refresh bound rejects 9 items before making network requests", async () => {
  let fetchCalls = 0;
  const { restore } = setupMockFetch(() => { fetchCalls++; return new Response("bad", { status: 500 }); });
  try {
    const items = Array.from({ length: 9 }, (_, index) => ({
      sourceUrl: imageUrl(`/2/user/${index}`, true),
      mediaId: `media_${index}`,
      mode: "refresh" as const,
    }));
    await assert.rejects(() => processImageRefreshBatch(env, credentials, items), /最多 8 张/);
    assert.equal(fetchCalls, 0);
  } finally { restore(); }
});

test("worst-case 8 probes use no more than 40 image-related fetches", async () => {
  const items = Array.from({ length: MAX_IMAGE_REFRESH_BATCH_SIZE }, (_, index) => ({
    sourceUrl: "https://ima-notebook-prod.image.myqcloud.com/2/user/worst-" + index + "?q-signature=unknown",
    mediaId: "media_" + index, mode: "probe" as const,
  }));
  const attempts = new Map<string, number>();
  let fetchCalls = 0;
  const oldTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void) => { fn(); return 0; };
  const { restore } = setupMockFetch(req => {
    fetchCalls++;
    if (req.method === "HEAD" && req.url.includes("q-signature=unknown")) {
      return new Response(null, { status: 403 });
    }
    if (req.url.endsWith("get_media_info")) {
      const id = req.body.media_id as string;
      const count = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, count);
      if (count < 3) {
        return new Response(JSON.stringify({ code: 200001, msg: "rate limited", data: {} }), { status: 200 });
      }
      return imaResponse({ url_info: { url: imageUrl("/2/user/worst-" + id.replace("media_", ""), false) } });
    }
    if (req.method === "HEAD") return new Response(null, { status: 200 });
    return new Response("bad", { status: 500 });
  });
  try {
    const result = await processImageRefreshBatch(env, credentials, items);
    assert.equal(result.length, MAX_IMAGE_REFRESH_BATCH_SIZE);
    assert.equal(fetchCalls, MAX_IMAGE_REFRESH_BATCH_SIZE * 5);
  } finally {
    restore();
    globalThis.setTimeout = oldTimeout;
  }
});
