import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaKnowledge, ImaNotes } from "../../src/ima.ts";
import { MediaType } from "../../src/types.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch } from "../helpers/mock-fetch.ts";
import {
  buildContentDisposition,
  buildDownloadUrl,
  buildR2Key,
  getExportRetentionPolicy,
  sanitizeFileName,
} from "../../src/r2.ts";
import { registerTools } from "../../src/tools.ts";
import { McpServer } from "@modelcontextprotocol/server";
import worker from "../../src/index.ts";

function createMockR2Bucket() {
  const store = new Map<string, { data: Uint8Array | string; options?: any }>();
  return {
    async put(key: string, value: any, options?: any) {
      let data: Uint8Array | string;
      if (typeof value === "string") {
        data = value;
      } else if (value instanceof Uint8Array) {
        data = value;
      } else if (value && typeof value.getReader === "function") {
        const reader = value.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          chunks.push(chunk);
        }
        const total = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        data = merged;
      } else {
        data = new Uint8Array();
      }
      store.set(key, { data, options });
      const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      return { key, size };
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      const dataBytes = typeof item.data === "string" ? new TextEncoder().encode(item.data) : item.data;
      return {
        key,
        size: dataBytes.byteLength,
        httpEtag: "mock-etag-123",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(dataBytes);
            controller.close();
          },
        }),
        httpMetadata: item.options?.httpMetadata,
        writeHttpMetadata(headers: Headers) {
          const meta = item.options?.httpMetadata;
          if (meta?.contentType) headers.set("content-type", meta.contentType);
          if (meta?.contentDisposition) headers.set("content-disposition", meta.contentDisposition);
        },
      };
    },
    store,
  };
}

const mockCreds: ImaCredentials = {
  clientId: "test_client_id",
  apiKey: "test_api_key",
};

function downloadEnv(overrides: Partial<Env> = {}): Env {
  return {
    IMA_DOWNLOAD_SIGNING_KEY: "test-only-download-signing-key",
    PUBLIC_BASE_URL: "https://ima.example.com",
    ...overrides,
  };
}

test("sanitizeFileName strips traversal paths, null bytes, and adds extension if missing", () => {
  assert.strictEqual(sanitizeFileName("../../../etc/passwd", "pdf"), "passwd.pdf");
  assert.strictEqual(sanitizeFileName("file\x00name?.pdf"), "filename?.pdf");
  assert.strictEqual(sanitizeFileName("   ", "txt"), "exported_file.txt");
  assert.strictEqual(sanitizeFileName("document.docx", "docx"), "document.docx");
  assert.strictEqual(sanitizeFileName("my_notes", "md"), "my_notes.md");
});

test("buildR2Key includes a unique export id so repeated exports cannot overwrite older objects", () => {
  assert.strictEqual(
    buildR2Key("media", "media/123", "file.pdf", "export-1"),
    "exports/media/media_123/export-1/file.pdf",
  );
  const first = buildR2Key("notes", "note_1", "note.md");
  const second = buildR2Key("notes", "note_1", "note.md");
  assert.notStrictEqual(first, second);
  assert.match(first, /^exports\/notes\/note_1\/[0-9a-f-]+\/note\.md$/i);
});

test("temporary download policy defaults to one hour and seven days and rejects retention shorter than TTL", () => {
  assert.deepEqual(getExportRetentionPolicy({}), {
    downloadTtlSeconds: 3600,
    retentionSeconds: 604800,
  });
  assert.deepEqual(
    getExportRetentionPolicy({ IMA_DOWNLOAD_TTL_SECONDS: "120", IMA_EXPORT_RETENTION_SECONDS: "3600" }),
    { downloadTtlSeconds: 120, retentionSeconds: 3600 },
  );
  assert.throws(
    () => getExportRetentionPolicy({ IMA_DOWNLOAD_TTL_SECONDS: "7200", IMA_EXPORT_RETENTION_SECONDS: "3600" }),
    /must be greater than or equal/,
  );
});

test("buildDownloadUrl returns an object-bound expiring Worker URL and never a public R2 direct URL", () => {
  const now = 1_800_000_000;
  const key = "exports/media/123/export-1/file.pdf";
  const url = new URL(buildDownloadUrl(downloadEnv(), key, undefined, now));
  assert.strictEqual(url.origin, "https://ima.example.com");
  assert.strictEqual(decodeURIComponent(url.pathname.slice("/download/".length)), key);
  assert.strictEqual(url.searchParams.get("expires"), String(now + 3600));
  assert.match(url.searchParams.get("sig") ?? "", /^[A-Za-z0-9_-]+$/);
  assert.equal(url.toString().includes("MCP_ACCESS_TOKEN"), false);
});

test("buildContentDisposition outputs compliant ASCII and UTF-8 encoded filename", () => {
  const cd = buildContentDisposition("中文 测试 (test).pdf");
  assert.match(cd, /attachment;/);
  assert.match(cd, /filename\*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%B5%8B%E8%AF%95%20\(test\)\.pdf/);
});

test("ImaKnowledge.exportSource streams binary file into a unique R2 object and returns signed Worker URL", async () => {
  const mockR2 = createMockR2Bucket();
  const env: Env = downloadEnv({
    R2_BUCKET: mockR2 as any,
    IMA_BASE_URL: "https://ima.qq.com",
  });
  const fileBytes = new TextEncoder().encode("%PDF-1.4 mock binary PDF content");

  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          media_type: MediaType.PDF,
          url_info: {
            url: "https://cos.myqcloud.com/ima-bucket/docs/my_document.pdf",
            headers: { authorization: "signed-secret-token" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (req.url === "https://cos.myqcloud.com/ima-bucket/docs/my_document.pdf") {
      assert.strictEqual(req.headers["authorization"], "signed-secret-token");
      return new Response(fileBytes, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-length": String(fileBytes.length),
        },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(env, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(env, client);
    const result = await kb.exportSource("media_pdf_99", notes);

    assert.strictEqual(result.media_id, "media_pdf_99");
    assert.strictEqual(result.file_name, "my_document.pdf");
    assert.strictEqual(result.file_size, fileBytes.length);
    assert.strictEqual(result.content_type, "application/pdf");
    assert.match(result.key, /^exports\/media\/media_pdf_99\/[0-9a-f-]+\/my_document\.pdf$/i);
    const url = new URL(result.download_url);
    assert.strictEqual(url.origin, "https://ima.example.com");
    assert.strictEqual(decodeURIComponent(url.pathname.slice("/download/".length)), result.key);
    assert.ok(url.searchParams.get("expires"));
    assert.ok(url.searchParams.get("sig"));

    const stored = mockR2.store.get(result.key);
    assert.ok(stored);
    assert.strictEqual(stored.options?.httpMetadata?.contentType, "application/pdf");
    assert.match(stored.options?.httpMetadata?.contentDisposition, /my_document\.pdf/);
  } finally {
    restore();
  }
});

test("ImaNotes.exportNote exports markdown note to unique R2 object and returns signed Worker URL", async () => {
  const mockR2 = createMockR2Bucket();
  const env: Env = downloadEnv({
    R2_BUCKET: mockR2 as any,
    IMA_BASE_URL: "https://ima.qq.com",
  });
  const noteMarkdown = "# 项目会议纪要\n\n- 讨论要点 1\n- 讨论要点 2";

  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_doc_content")) {
      assert.strictEqual(req.body.note_id, "note_777");
      return new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: { content: noteMarkdown },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(env, mockCreds);
    const notes = new ImaNotes(client);
    const result = await notes.exportNote("note_777");

    assert.strictEqual(result.note_id, "note_777");
    assert.strictEqual(result.file_name, "项目会议纪要.md");
    assert.strictEqual(result.content_type, "text/markdown; charset=utf-8");
    assert.match(result.key, /^exports\/notes\/note_777\/[0-9a-f-]+\/项目会议纪要\.md$/i);
    assert.strictEqual(decodeURIComponent(new URL(result.download_url).pathname.slice("/download/".length)), result.key);

    const stored = mockR2.store.get(result.key);
    assert.ok(stored);
    const text = new TextDecoder().decode(stored.data as Uint8Array);
    assert.strictEqual(text, noteMarkdown);
  } finally {
    restore();
  }
});

test("ImaKnowledge.exportSource delegates note-type media_id to signed note export", async () => {
  const mockR2 = createMockR2Bucket();
  const env: Env = downloadEnv({
    R2_BUCKET: mockR2 as any,
    PUBLIC_BASE_URL: "https://ima.subdomain.workers.dev",
    IMA_BASE_URL: "https://ima.qq.com",
  });

  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          media_type: MediaType.Note,
          notebook_ext_info: { notebook_id: "linked_note_88" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (req.url.endsWith("get_doc_content")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: { content: "Simple content without title header" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(env, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(env, client);
    const result = await kb.exportSource("media_as_note_88", notes);
    assert.strictEqual(result.note_id, "linked_note_88");
    assert.strictEqual(result.file_name, "Note_linked_note_88.md");
    assert.match(result.download_url, /^https:\/\/ima\.subdomain\.workers\.dev\/download\//);
    assert.ok(new URL(result.download_url).searchParams.get("sig"));
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource with R2 returns a signed download_url for binary media", async () => {
  const mockR2 = createMockR2Bucket();
  const env: Env = downloadEnv({
    R2_BUCKET: mockR2 as any,
    IMA_BASE_URL: "https://ima.qq.com",
  });
  const binaryData = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          media_type: MediaType.Xmind,
          url_info: { url: "https://cos.myqcloud.com/files/project.xmind" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (req.url === "https://cos.myqcloud.com/files/project.xmind") {
      return new Response(binaryData, {
        status: 200,
        headers: {
          "content-type": "application/x-xmind",
          "content-length": String(binaryData.length),
        },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(env, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(env, client);
    const result = await kb.readSource("media_xmind", notes);
    assert.strictEqual(result.media_id, "media_xmind");
    assert.strictEqual(result.file_name, "project.xmind");
    assert.match(result.download_url ?? "", /^https:\/\/ima\.example\.com\/download\//);
    assert.ok(new URL(result.download_url!).searchParams.get("sig"));
    assert.strictEqual(result.is_end, true);
    assert.strictEqual(result.content, undefined);
  } finally {
    restore();
  }
});

test("Worker signed download route accepts valid links and rejects unsigned, tampered, and expired links", async () => {
  const mockR2 = createMockR2Bucket();
  const key = "exports/media/1/export-1/test.txt";
  const testBytes = new TextEncoder().encode("Hello downloaded content!");
  await mockR2.put(key, testBytes, {
    httpMetadata: {
      contentType: "text/plain; charset=utf-8",
      contentDisposition: 'attachment; filename="test.txt"',
    },
  });

  const envWithR2: Env = downloadEnv({ R2_BUCKET: mockR2 as any });
  const now = Math.floor(Date.now() / 1000);
  const signedUrl = buildDownloadUrl(envWithR2, key, undefined, now);

  const success = await worker.fetch(new Request(signedUrl), envWithR2, {} as any);
  assert.strictEqual(success.status, 200);
  assert.strictEqual(success.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.strictEqual(success.headers.get("content-disposition"), 'attachment; filename="test.txt"');
  assert.strictEqual(success.headers.get("etag"), "mock-etag-123");
  assert.strictEqual(success.headers.get("cache-control"), "private, no-store");
  assert.strictEqual(await success.text(), "Hello downloaded content!");

  const unsigned = await worker.fetch(
    new Request(`https://ima.example.com/download/${encodeURIComponent(key)}`),
    envWithR2,
    {} as any,
  );
  assert.strictEqual(unsigned.status, 403);

  const tamperedKey = new URL(signedUrl);
  tamperedKey.pathname = `/download/${encodeURIComponent("exports/media/1/export-2/test.txt")}`;
  const tamperedKeyResponse = await worker.fetch(new Request(tamperedKey), envWithR2, {} as any);
  assert.strictEqual(tamperedKeyResponse.status, 403);

  const tamperedExpiry = new URL(signedUrl);
  tamperedExpiry.searchParams.set("expires", String(Number(tamperedExpiry.searchParams.get("expires")) + 1));
  const tamperedExpiryResponse = await worker.fetch(new Request(tamperedExpiry), envWithR2, {} as any);
  assert.strictEqual(tamperedExpiryResponse.status, 403);

  const expiredUrl = buildDownloadUrl(envWithR2, key, undefined, now - 7200);
  const expired = await worker.fetch(new Request(expiredUrl), envWithR2, {} as any);
  assert.strictEqual(expired.status, 410);

  const missingKey = "exports/media/1/export-1/missing.txt";
  const notFound = await worker.fetch(
    new Request(buildDownloadUrl(envWithR2, missingKey, undefined, now)),
    envWithR2,
    {} as any,
  );
  assert.strictEqual(notFound.status, 404);

  const noSigningSecret: Env = { R2_BUCKET: mockR2 as any };
  const signingMisconfigured = await worker.fetch(
    new Request(`https://ima.example.com/download/${encodeURIComponent(key)}?expires=${now + 3600}&sig=x`),
    noSigningSecret,
    {} as any,
  );
  assert.strictEqual(signingMisconfigured.status, 503);

  const noR2: Env = downloadEnv();
  const noBucket = await worker.fetch(new Request(signedUrl), noR2, {} as any);
  assert.strictEqual(noBucket.status, 503);
});

test("ImaKnowledge.exportSource throws clear error when R2_BUCKET is missing", async () => {
  const envNoR2: Env = downloadEnv();
  const client = new ImaClient(envNoR2, mockCreds);
  const kb = new ImaKnowledge(envNoR2, client);
  const notes = new ImaNotes(client);

  await assert.rejects(
    async () => kb.exportSource("media_1", notes),
    /R2 bucket 未配置/,
  );
});

test("registerTools registers export_file in both readOnly and allowWrite modes", async () => {
  const env: Env = downloadEnv();
  const client = new ImaClient(env, mockCreds);
  const notes = new ImaNotes(client);
  const kb = new ImaKnowledge(env, client);

  const serverRo = new McpServer({ name: "test-ro", version: "1.0.0" });
  registerTools(serverRo, notes, kb, false);
  const registeredRo = Object.keys((serverRo as any)._registeredTools || {});
  assert.ok(registeredRo.includes("export_file"));
  assert.ok(registeredRo.includes("read_knowledge_source"));
  assert.ok(!registeredRo.includes("create_note"));

  const serverRw = new McpServer({ name: "test-rw", version: "1.0.0" });
  registerTools(serverRw, notes, kb, true);
  const registeredRw = Object.keys((serverRw as any)._registeredTools || {});
  assert.ok(registeredRw.includes("export_file"));
  assert.ok(registeredRw.includes("create_note"));
});
