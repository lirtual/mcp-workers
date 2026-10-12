import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaKnowledge, ImaNotes } from "../../src/ima.ts";
import { ImaApiError } from "../../src/types.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch } from "../helpers/mock-fetch.ts";

const mockEnv: Env = {
  DB: {} as any,
  IMA_BASE_URL: "https://ima.qq.com",
};

const mockCreds: ImaCredentials = {
  clientId: "test_client_id",
  apiKey: "test_api_key",
};

test("ImaKnowledge.importUrls validates URLs and rejects non-HTTPS or video URLs before sending", async () => {
  const client = new ImaClient(mockEnv, mockCreds);
  const kb = new ImaKnowledge(mockEnv, client);

  await assert.rejects(
    async () => kb.importUrls("kb_123", ["file:///local/path"]),
    /不支持 file:\/\/ 协议/i
  );

  await assert.rejects(
    async () => kb.importUrls("kb_123", ["https://www.bilibili.com/video/BV123"]),
    /Bilibili 视频链接仅支持在 ima 桌面端/i
  );

  await assert.rejects(
    async () => kb.importUrls("kb_123", ["https://arxiv.org/pdf/2301.00001.pdf"]),
    /upload_file_to_knowledge_base/i
  );
});

test("ImaKnowledge.importUrls correctly parses Map<string, ImportURLData> contract for partial failures", async () => {
  const { restore } = setupMockFetch(() => {
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          results: {
            "https://mp.weixin.qq.com/s/good_article": {
              ret_code: 0,
              ret_msg: "ok",
              media_id: "media_good_1",
            },
            "https://example.com/bad_page": {
              ret_code: 110001,
              ret_msg: "网页抓取失败",
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);

    const res = await kb.importUrls("kb_123", [
      "https://mp.weixin.qq.com/s/good_article",
      "https://example.com/bad_page",
    ]);

    assert.strictEqual(res.partial_failure, true);
    assert.strictEqual(res.succeeded.length, 1);
    assert.strictEqual(res.failed.length, 1);
    assert.strictEqual(res.succeeded[0].url, "https://mp.weixin.qq.com/s/good_article");
    assert.strictEqual(res.succeeded[0].media_id, "media_good_1");
    assert.strictEqual(res.failed[0].url, "https://example.com/bad_page");
    assert.strictEqual(res.failed[0].ret_code, 110001);
    assert.match(res.summary, /成功导入 1 个 URL，失败 1 个 URL/);
  } finally {
    restore();
  }
});

test("ImaKnowledge.importUrls parses Map<string, ImportURLData> when all items succeed", async () => {
  const { restore } = setupMockFetch(() => {
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          results: {
            "https://mp.weixin.qq.com/s/good_1": {
              ret_code: 0,
              ret_msg: "ok",
              media_id: "media_1",
            },
            "https://mp.weixin.qq.com/s/good_2": {
              ret_code: 0,
              ret_msg: "ok",
              media_id: "media_2",
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);

    const res = await kb.importUrls("kb_123", [
      "https://mp.weixin.qq.com/s/good_1",
      "https://mp.weixin.qq.com/s/good_2",
    ]);

    assert.strictEqual(res.partial_failure, false);
    assert.strictEqual(res.succeeded.length, 2);
    assert.strictEqual(res.failed.length, 0);
    assert.match(res.summary, /全部 2 个 URL 导入成功/);
  } finally {
    restore();
  }
});

test("ImaKnowledge.importUrls throws ImaApiError when all items fail in Map results", async () => {
  const { restore } = setupMockFetch(() => {
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          results: {
            "https://example.com/bad_1": {
              ret_code: 110001,
              ret_msg: "链接超时",
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);

    await assert.rejects(
      async () => kb.importUrls("kb_123", ["https://example.com/bad_1"]),
      (err: unknown) => {
        assert(err instanceof ImaApiError);
        assert.strictEqual(err.code, 110011);
        assert.match(err.message, /所有 URL 导入失败/);
        assert(err.details && Array.isArray((err.details as any).failed));
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("ImaKnowledge.importUrls rejects a missing or empty result map for requested URLs", async () => {
  for (const data of [{}, { results: {} }]) {
    const { restore } = setupMockFetch(() =>
      new Response(JSON.stringify({ code: 0, msg: "ok", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    try {
      const client = new ImaClient(mockEnv, mockCreds);
      const kb = new ImaKnowledge(mockEnv, client);
      await assert.rejects(
        () => kb.importUrls("kb_123", ["https://example.com/article"]),
        (error: unknown) => error instanceof ImaApiError && error.code === 110011
      );
    } finally {
      restore();
    }
  }
});

test("ImaKnowledge.importUrls rejects incomplete per-URL results", async () => {
  const { restore } = setupMockFetch(() => new Response(JSON.stringify({
    code: 0,
    data: {
      results: {
        "https://example.com/one": { ret_code: 0, media_id: "media_1" },
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } }));

  try {
    const kb = new ImaKnowledge(mockEnv, new ImaClient(mockEnv, mockCreds));
    await assert.rejects(
      () => kb.importUrls("kb_123", ["https://example.com/one", "https://example.com/two"]),
      /未返回完整结果/
    );
  } finally {
    restore();
  }
});

test("ImaNotes.create and append validate required note_id in response", async () => {
  const { restore } = setupMockFetch(() => {
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "ok",
        data: {}, // Missing note_id!
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);

    await assert.rejects(
      async () => notes.create({ content: "# Hello" }),
      /note_id/i
    );

    await assert.rejects(
      async () => notes.append("note_123", "extra content"),
      /note_id/i
    );
  } finally {
    restore();
  }
});

test("ImaClient preserves business error codes like 210008 and 210009", async () => {
  const { restore } = setupMockFetch(() => {
    return new Response(
      JSON.stringify({
        code: 210008,
        msg: "Version conflict: document has been modified concurrently",
        data: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);

    await assert.rejects(
      async () => notes.append("note_123", "conflict test"),
      (err: unknown) => {
        assert(err instanceof ImaApiError);
        assert.strictEqual(err.code, 210008);
        assert.match(err.message, /Version conflict/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("ImaClient rejects an oversized API response before buffering it unbounded", async () => {
  const { restore } = setupMockFetch(() => new Response(JSON.stringify({
    code: 0,
    data: { content: "x".repeat(128) },
  }), { status: 200, headers: { "content-type": "application/json" } }));

  try {
    const client = new ImaClient({ ...mockEnv, IMA_RESPONSE_MAX_BYTES: "32" }, mockCreds);
    await assert.rejects(() => client.post("openapi/test", {}), /超出大小限制/);
  } finally {
    restore();
  }
});
