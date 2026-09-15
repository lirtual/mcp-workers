import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaKnowledge, ImaNotes } from "../../src/ima.ts";
import { MediaType } from "../../src/types.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch } from "../helpers/mock-fetch.ts";
import { buildContentDisposition, buildDownloadUrl, buildR2Key, sanitizeFileName } from "../../src/r2.ts";
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
        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
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

test("sanitizeFileName strips traversal paths, null bytes, and adds extension if missing", () => {
  assert.strictEqual(sanitizeFileName("../../../etc/passwd", "pdf"), "passwd.pdf");
  assert.strictEqual(sanitizeFileName("file\x00name?.pdf"), "filename?.pdf");
  assert.strictEqual(sanitizeFileName("   ", "txt"), "exported_file.txt");
  assert.strictEqual(sanitizeFileName("document.docx", "docx"), "document.docx");
  assert.strictEqual(sanitizeFileName("my_notes", "md"), "my_notes.md");
});

test("buildDownloadUrl supports custom domain with various URL shapes and fallback to worker route", () => {
  const mockEnvFallback: Env = {
    DB: {} as any,
    PUBLIC_BASE_URL: "https://ima.example.com",
  };
  assert.strictEqual(
    buildDownloadUrl(mockEnvFallback, "exports/media/123/file.pdf"),
    "https://ima.example.com/download/exports/media/123/file.pdf"
  );

  const mockEnvCustom: Env = {
    DB: {} as any,
    R2_CUSTOM_DOMAIN: "cdn.example.com",
  };
  assert.strictEqual(
    buildDownloadUrl(mockEnvCustom, "exports/media/123/file.pdf"),
    "https://cdn.example.com/exports/media/123/file.pdf"
  );

  const mockEnvCustomWithScheme: Env = {
    DB: {} as any,
    R2_CUSTOM_DOMAIN: "https://download.assets.io/",
  };
  assert.strictEqual(
    buildDownloadUrl(mockEnvCustomWithScheme, "/exports/notes/456/note.md"),
    "https://download.assets.io/exports/notes/456/note.md"
  );
});

test("buildContentDisposition outputs compliant ASCII and UTF-8 encoded filename", () => {
  const cd = buildContentDisposition("中文 测试 (test).pdf");
  assert.match(cd, /attachment;/);
  assert.match(cd, /filename\*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%B5%8B%E8%AF%95%20\(test\)\.pdf/);
});

test("ImaKnowledge.exportSource streams binary file from upstream COS directly into R2", async () => {
  const mockR2 = createMockR2Bucket();
  const env: Env = {
    DB: {} as any,
    R2_BUCKET: mockR2 as any,
    R2_CUSTOM_DOMAIN: "https://r2.example.com",
    IMA_BASE_URL: "https://ima.qq.com",
  };

  const fileBytes = new TextEncoder().encode("%PDF-1.4 mock binary PDF content");

  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_type: MediaType.PDF,
            url_info: {
              url: "https://cos.myqcloud.com/ima-bucket/docs/my_document.pdf",
              headers: { authorization: "signed-secret-token" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
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
    assert.strictEqual(result.download_url, "https://r2.example.com/exports/media/media_pdf_99/my_document.pdf");
    assert.strictEqual(result.key, "exports/media/media_pdf_99/my_document.pdf");

    // Verify file is actually in R2 store
    assert.ok(mockR2.store.has("exports/media/media_pdf_99/my_document.pdf"));
    const stored = mockR2.store.get("exports/media/media_pdf_99/my_document.pdf");
    assert.strictEqual(stored?.options?.httpMetadata?.contentType, "application/pdf");
    assert.match(stored?.options?.httpMetadata?.contentDisposition, /my_document\.pdf/);
  } finally {
    restore();
  }
});

test("ImaNotes.exportNote exports markdown note to R2 and resolves title from markdown header", async () => {
  const mockR2 = createMockR2Bucket();
  const env: Env = {
    DB: {} as any,
    R2_BUCKET: mockR2 as any,
    R2_CUSTOM_DOMAIN: "cdn.notes.com",
    IMA_BASE_URL: "https://ima.qq.com",
  };

  const noteMarkdown = "# 项目会议纪要\n\n- 讨论要点 1\n- 讨论要点 2";

  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_doc_content")) {
      assert.strictEqual(req.body.note_id, "note_777");
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            content: noteMarkdown,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
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
    assert.strictEqual(result.download_url, "https://cdn.notes.com/exports/notes/note_777/项目会议纪要.md");
    assert.strictEqual(result.key, "exports/notes/note_777/项目会议纪要.md");

    // Check R2 stored content
    const stored = mockR2.store.get(result.key);
    assert.ok(stored);
    const text = new TextDecoder().decode(stored.data as Uint8Array);
    assert.strictEqual(text, noteMarkdown);
  } finally {
    restore();
  }
});

test("ImaKnowledge.exportSource delegates note-type media_id (media_type=11) to exportNote", async () => {
  const mockR2 = createMockR2Bucket();
  const env: Env = {
    DB: {} as any,
    R2_BUCKET: mockR2 as any,
    PUBLIC_BASE_URL: "https://ima.subdomain.workers.dev",
    IMA_BASE_URL: "https://ima.qq.com",
  };

  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_type: MediaType.Note,
            notebook_ext_info: { notebook_id: "linked_note_88" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.endsWith("get_doc_content")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            content: "Simple content without title header",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
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
    // Fallback URL when no R2_CUSTOM_DOMAIN
    assert.strictEqual(
      result.download_url,
      "https://ima.subdomain.workers.dev/download/exports/notes/linked_note_88/Note_linked_note_88.md"
    );
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource with R2 automatically returns download_url for binary media", async () => {
  const mockR2 = createMockR2Bucket();
  const env: Env = {
    DB: {} as any,
    R2_BUCKET: mockR2 as any,
    R2_CUSTOM_DOMAIN: "https://cdn.ima.com",
    IMA_BASE_URL: "https://ima.qq.com",
  };

  const binaryData = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // Zip magic

  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_type: MediaType.Xmind,
            url_info: {
              url: "https://cos.myqcloud.com/files/project.xmind",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
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
    assert.strictEqual(result.download_url, "https://cdn.ima.com/exports/media/media_xmind/project.xmind");
    assert.strictEqual(result.is_end, true);
    assert.strictEqual(result.content, undefined); // No 2MB base64 chunk
  } finally {
    restore();
  }
});

test("Worker GET /download/:key route serves object from R2 with headers and handles 404/503", async () => {
  const mockR2 = createMockR2Bucket();
  const testBytes = new TextEncoder().encode("Hello downloaded content!");
  await mockR2.put("exports/media/1/test.txt", testBytes, {
    httpMetadata: {
      contentType: "text/plain; charset=utf-8",
      contentDisposition: 'attachment; filename="test.txt"',
    },
  });

  const envWithR2: Env = {
    DB: {} as any,
    R2_BUCKET: mockR2 as any,
  };

  // 1. Successful download
  const reqSuccess = new Request("https://ima-mcp.workers.dev/download/exports/media/1/test.txt");
  const resSuccess = await worker.fetch(reqSuccess, envWithR2, {} as any);
  assert.strictEqual(resSuccess.status, 200);
  assert.strictEqual(resSuccess.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.strictEqual(resSuccess.headers.get("content-disposition"), 'attachment; filename="test.txt"');
  assert.strictEqual(resSuccess.headers.get("etag"), "mock-etag-123");
  assert.strictEqual(await resSuccess.text(), "Hello downloaded content!");

  // 2. 404 Not Found
  const req404 = new Request("https://ima-mcp.workers.dev/download/exports/non_existent.pdf");
  const res404 = await worker.fetch(req404, envWithR2, {} as any);
  assert.strictEqual(res404.status, 404);

  // 3. 503 Bucket unconfigured
  const envNoR2: Env = {
    DB: {} as any,
  };
  const req503 = new Request("https://ima-mcp.workers.dev/download/exports/any.pdf");
  const res503 = await worker.fetch(req503, envNoR2, {} as any);
  assert.strictEqual(res503.status, 503);
});

test("ImaKnowledge.exportSource throws clear error when R2_BUCKET is missing", async () => {
  const envNoR2: Env = {
    DB: {} as any,
  };
  const client = new ImaClient(envNoR2, mockCreds);
  const kb = new ImaKnowledge(envNoR2, client);
  const notes = new ImaNotes(client);

  await assert.rejects(
    async () => kb.exportSource("media_1", notes),
    /R2 bucket 未配置/
  );
});

test("registerTools registers export_file in both readOnly and allowWrite modes", async () => {
  const env: Env = { DB: {} as any };
  const client = new ImaClient(env, mockCreds);
  const notes = new ImaNotes(client);
  const kb = new ImaKnowledge(env, client);

  // 1. Read-only mode (allowWrite = false)
  const serverRo = new McpServer({ name: "test-ro", version: "1.0.0" });
  registerTools(serverRo, notes, kb, false);
  const registeredRo = Object.keys((serverRo as any)._registeredTools || {});
  assert.ok(registeredRo.includes("export_file"));
  assert.ok(registeredRo.includes("read_knowledge_source"));
  assert.ok(!registeredRo.includes("create_note"));

  // 2. Write mode (allowWrite = true)
  const serverRw = new McpServer({ name: "test-rw", version: "1.0.0" });
  registerTools(serverRw, notes, kb, true);
  const registeredRw = Object.keys((serverRw as any)._registeredTools || {});
  assert.ok(registeredRw.includes("export_file"));
  assert.ok(registeredRw.includes("create_note"));
});
