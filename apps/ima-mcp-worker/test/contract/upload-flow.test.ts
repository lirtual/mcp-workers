import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaKnowledge } from "../../src/ima.ts";
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

test("ImaKnowledge.upload completes full upload flow to COS and registers knowledge", async () => {
  const { captured, restore } = setupMockFetch(req => {
    // 1. Remote file download
    if (req.url === "https://files.example.com/spec.pdf") {
      return new Response("dummy pdf content", {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-length": "17",
        },
      });
    }
    // 2. check_repeated_names
    if (req.url.endsWith("check_repeated_names")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            results: [{ is_repeated: false }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // 3. create_media
    if (req.url.endsWith("create_media")) {
      assert.strictEqual(req.body.file_name, "spec.pdf");
      assert.strictEqual(req.body.file_size, 17);
      assert.strictEqual(req.body.content_type, "application/pdf");
      assert.strictEqual(req.body.file_ext, "pdf");
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_id: "media_spec_1",
            cos_credential: {
              secret_id: "sid_123",
              secret_key: "skey_123",
              token: "tok_123",
              bucket_name: "test-bucket",
              region: "ap-guangzhou",
              cos_key: "wiki/user/spec.pdf",
              start_time: "1700000000",
              expired_time: "1700003600",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // 4. COS PUT
    if (req.url.includes("myqcloud.com")) {
      assert.strictEqual(req.method, "PUT");
      assert.strictEqual(req.headers["x-cos-security-token"], "tok_123");
      assert.match(req.headers["authorization"] || "", /q-sign-algorithm=sha1/);
      return new Response("", { status: 200 });
    }
    // 5. add_knowledge
    if (req.url.endsWith("add_knowledge")) {
      assert.strictEqual(req.body.media_type, 1);
      assert.strictEqual(req.body.media_id, "media_spec_1");
      assert.strictEqual(req.body.title, "spec.pdf");
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_id: "media_spec_1",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);

    const res = await kb.upload({
      knowledge_base_id: "kb_100",
      file_url: "https://files.example.com/spec.pdf",
      file_name: "spec.pdf",
    });

    assert.strictEqual(res.media_id, "media_spec_1");
    assert.strictEqual(res.file_name, "spec.pdf");
    assert.strictEqual(res.file_size, 17);
    assert.strictEqual(res.media_type, 1);
  } finally {
    restore();
  }
});

test("ImaKnowledge.upload blocks repeated name when keep_both is false", async () => {
  const { restore } = setupMockFetch(req => {
    if (req.url === "https://files.example.com/notes.md") {
      return new Response("# Notes", {
        status: 200,
        headers: { "content-type": "text/markdown", "content-length": "7" },
      });
    }
    if (req.url.endsWith("check_repeated_names")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            results: [{ is_repeated: true }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);

    await assert.rejects(
      async () =>
        kb.upload({
          knowledge_base_id: "kb_100",
          file_url: "https://files.example.com/notes.md",
          file_name: "notes.md",
          keep_both: false,
        }),
      /已存在同名文件.*keep_both=true/i
    );
  } finally {
    restore();
  }
});

test("ImaKnowledge.upload stops when duplicate-name validation returns no item", async () => {
  const { restore } = setupMockFetch(req => {
    if (req.url === "https://files.example.com/notes.md") {
      return new Response("# Notes", {
        status: 200,
        headers: { "content-type": "text/markdown", "content-length": "7" },
      });
    }
    if (req.url.endsWith("check_repeated_names")) {
      return new Response(JSON.stringify({ code: 0, msg: "ok", data: { results: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);
    await assert.rejects(
      () => kb.upload({
        knowledge_base_id: "kb_100",
        file_url: "https://files.example.com/notes.md",
        file_name: "notes.md",
      }),
      /重名检查.*有效结果/
    );
  } finally {
    restore();
  }
});

test("ImaKnowledge.upload uses the downloaded MIME type instead of a misleading extension", async () => {
  let duplicateMediaType: number | undefined;
  const { restore } = setupMockFetch(req => {
    if (req.url === "https://files.example.com/item.txt") {
      return new Response("%PDF fake", {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "9" },
      });
    }
    if (req.url.endsWith("check_repeated_names")) {
      duplicateMediaType = req.body.params[0].media_type;
      return new Response(JSON.stringify({ code: 0, data: { results: [{ name: "item.txt", is_repeated: true }] } }), {
        status: 200,
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);
    await assert.rejects(() => kb.upload({
      knowledge_base_id: "kb_100",
      file_url: "https://files.example.com/item.txt",
      file_name: "item.txt",
    }), /同名文件/);
    assert.strictEqual(duplicateMediaType, 1);
  } finally {
    restore();
  }
});

test("ImaKnowledge.upload infers an omitted filename from Content-Disposition", async () => {
  let duplicateName: string | undefined;
  const { restore } = setupMockFetch(req => {
    if (req.url === "https://files.example.com/download") {
      return new Response("%PDF fake", {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-length": "9",
          "content-disposition": 'attachment; filename="annual-report.pdf"',
        },
      });
    }
    if (req.url.endsWith("check_repeated_names")) {
      duplicateName = req.body.params[0].name;
      return new Response(JSON.stringify({ code: 0, data: { results: [{ name: duplicateName, is_repeated: true }] } }), {
        status: 200,
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);
    await assert.rejects(() => kb.upload({
      knowledge_base_id: "kb_100",
      file_url: "https://files.example.com/download",
    }), /同名文件/);
    assert.strictEqual(duplicateName, "annual-report.pdf");
  } finally {
    restore();
  }
});

test("ImaKnowledge.upload cancels the download body when a pre-upload gate fails", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("# Notes"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const { restore } = setupMockFetch(req => {
    if (req.url === "https://files.example.com/notes.md") {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/markdown", "content-length": "7" },
      });
    }
    if (req.url.endsWith("check_repeated_names")) {
      return new Response(JSON.stringify({ code: 0, data: { results: [{ name: "notes.md", is_repeated: true }] } }), {
        status: 200,
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);
    await assert.rejects(() => kb.upload({
      knowledge_base_id: "kb_100",
      file_url: "https://files.example.com/notes.md",
      file_name: "notes.md",
    }), /同名文件/);
    assert.strictEqual(cancelled, true);
  } finally {
    restore();
  }
});

test("ImaKnowledge.upload bounds downloads that omit Content-Length", async () => {
  let apiCalled = false;
  const { restore } = setupMockFetch(req => {
    if (req.url === "https://files.example.com/unbounded.pdf") {
      return new Response(new Uint8Array(9), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    apiCalled = true;
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const env = { ...mockEnv, FILE_DOWNLOAD_MAX_BUFFER_BYTES: "8" };
    const kb = new ImaKnowledge(env, new ImaClient(env, mockCreds));
    await assert.rejects(() => kb.upload({
      knowledge_base_id: "kb_100",
      file_url: "https://files.example.com/unbounded.pdf",
    }), /超出大小限制/);
    assert.strictEqual(apiCalled, false);
  } finally {
    restore();
  }
});

test("ImaKnowledge.upload appends timestamp when keep_both is true on repeated name", async () => {
  let createdFileName = "";
  const { restore } = setupMockFetch(req => {
    if (req.url === "https://files.example.com/notes.md") {
      return new Response("# Notes", {
        status: 200,
        headers: { "content-type": "text/markdown", "content-length": "7" },
      });
    }
    if (req.url.endsWith("check_repeated_names")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            results: [{ is_repeated: true }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.endsWith("create_media")) {
      createdFileName = req.body.file_name;
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_id: "media_md_dupe",
            cos_credential: {
              secret_id: "sid",
              secret_key: "skey",
              token: "tok",
              bucket_name: "b",
              region: "r",
              cos_key: "k",
              start_time: "1",
              expired_time: "2",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.includes("myqcloud.com")) {
      return new Response("", { status: 200 });
    }
    if (req.url.endsWith("add_knowledge")) {
      return new Response(
        JSON.stringify({ code: 0, msg: "ok", data: { media_id: "media_md_dupe" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);

    const res = await kb.upload({
      knowledge_base_id: "kb_100",
      file_url: "https://files.example.com/notes.md",
      file_name: "notes.md",
      keep_both: true,
    });

    assert.match(createdFileName, /^notes_\d{14}\.md$/);
    assert.strictEqual(res.file_name, createdFileName);
  } finally {
    restore();
  }
});

test("ImaKnowledge.upload rejects when COS credentials have invalid timestamps (expired_time <= start_time)", async () => {
  const { restore } = setupMockFetch((req) => {
    if (req.url === "https://files.example.com/notes.md") {
      return new Response("# Notes", {
        status: 200,
        headers: { "content-type": "text/markdown", "content-length": "7" },
      });
    }
    if (req.url.endsWith("check_repeated_names")) {
      return new Response(
        JSON.stringify({ code: 0, msg: "ok", data: { results: [{ is_repeated: false }] } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.endsWith("create_media")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_id: "media_expired",
            cos_credential: {
              secret_id: "sid",
              secret_key: "skey",
              token: "tok",
              bucket_name: "b",
              region: "r",
              cos_key: "k",
              start_time: "1700003600",
              expired_time: "1700000000", // expired before start!
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);

    await assert.rejects(
      async () =>
        kb.upload({
          knowledge_base_id: "kb_100",
          file_url: "https://files.example.com/notes.md",
          file_name: "notes.md",
        }),
      /COS 凭据时间戳非法/
    );
  } finally {
    restore();
  }
});

test("ImaKnowledge.upload rejects when add_knowledge response is missing media_id", async () => {
  const { restore } = setupMockFetch((req) => {
    if (req.url === "https://files.example.com/notes.md") {
      return new Response("# Notes", {
        status: 200,
        headers: { "content-type": "text/markdown", "content-length": "7" },
      });
    }
    if (req.url.endsWith("check_repeated_names")) {
      return new Response(
        JSON.stringify({ code: 0, msg: "ok", data: { results: [{ is_repeated: false }] } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.endsWith("create_media")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_id: "media_no_add",
            cos_credential: {
              secret_id: "sid",
              secret_key: "skey",
              token: "tok",
              bucket_name: "b",
              region: "r",
              cos_key: "k",
              start_time: "1000",
              expired_time: "2000000000",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.includes("myqcloud.com")) {
      return new Response("", { status: 200 });
    }
    if (req.url.endsWith("add_knowledge")) {
      return new Response(
        JSON.stringify({ code: 0, msg: "ok", data: {} }), // Missing media_id!
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);

    await assert.rejects(
      async () =>
        kb.upload({
          knowledge_base_id: "kb_100",
          file_url: "https://files.example.com/notes.md",
          file_name: "notes.md",
        }),
      /add_knowledge.*media_id/
    );
  } finally {
    restore();
  }
});

test("ImaKnowledge.uploadBatch handles multiple files with partial failure summary", async () => {
  const { restore } = setupMockFetch((req) => {
    if (req.url === "https://files.example.com/doc1.pdf") {
      return new Response("pdf content", {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "11" },
      });
    }
    if (req.url === "https://files.example.com/doc2.pdf") {
      return new Response("pdf content 2", {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "13" },
      });
    }
    if (req.url.endsWith("check_repeated_names")) {
      // If doc2.pdf, report duplicate
      const isDupe = req.body?.params?.[0]?.name === "doc2.pdf";
      return new Response(
        JSON.stringify({ code: 0, msg: "ok", data: { results: [{ is_repeated: isDupe }] } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.endsWith("create_media")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_id: "media_batch_1",
            cos_credential: {
              secret_id: "sid",
              secret_key: "skey",
              token: "tok",
              bucket_name: "b",
              region: "r",
              cos_key: "k",
              start_time: "1000",
              expired_time: "2000000000",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.includes("myqcloud.com")) {
      return new Response("", { status: 200 });
    }
    if (req.url.endsWith("add_knowledge")) {
      return new Response(
        JSON.stringify({ code: 0, msg: "ok", data: { media_id: "media_batch_1" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const kb = new ImaKnowledge(mockEnv, client);

    const res = await kb.uploadBatch("kb_100", [
      { file_url: "https://files.example.com/doc1.pdf", file_name: "doc1.pdf" },
      { file_url: "https://files.example.com/doc2.pdf", file_name: "doc2.pdf", keep_both: false },
    ]);

    assert.strictEqual(res.results.length, 2);
    assert.strictEqual(res.succeeded.length, 1);
    assert.strictEqual(res.failed.length, 1);
    assert.strictEqual(res.succeeded[0].file_name, "doc1.pdf");
    assert.strictEqual(res.succeeded[0].media_id, "media_batch_1");
    assert.strictEqual(res.failed[0].file_name, "doc2.pdf");
    assert.match(res.failed[0].error || "", /已存在同名文件/);
    assert.match(res.summary, /成功 1 个，失败 1 个/);
  } finally {
    restore();
  }
});
