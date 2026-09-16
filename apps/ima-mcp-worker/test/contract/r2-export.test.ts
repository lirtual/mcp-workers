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
  sanitizeFileName,
} from "../../src/r2.ts";
import { registerTools } from "../../src/tools.ts";
import { McpServer } from "@modelcontextprotocol/server";

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
    store,
  };
}

const mockCreds: ImaCredentials = {
  clientId: "test_client_id",
  apiKey: "test_api_key",
};

function downloadEnv(overrides: Partial<Env> = {}): Env {
  return {
    R2_PUBLIC_BASE_URL: "https://ima-files.example.com",
    ...overrides,
  };
}

function encodedObjectPath(key: string): string {
  return `/${key.split("/").map(segment => encodeURIComponent(segment)).join("/")}`;
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

test("buildDownloadUrl returns the direct R2 custom-domain object URL", async () => {
  const key = "exports/media/123/export-1/中文 file?.pdf";
  const url = new URL(await buildDownloadUrl(downloadEnv(), key));
  assert.strictEqual(url.origin, "https://ima-files.example.com");
  assert.strictEqual(url.pathname, encodedObjectPath(key));
  assert.strictEqual(url.search, "");
});

test("buildDownloadUrl rejects missing, non-HTTPS, or non-origin public bases", async () => {
  await assert.rejects(() => buildDownloadUrl({}, "exports/media/1/file.pdf"), /not configured/);
  await assert.rejects(
    () => buildDownloadUrl({ R2_PUBLIC_BASE_URL: "http://files.example.com" }, "exports/media/1/file.pdf"),
    /must use HTTPS/,
  );
  await assert.rejects(
    () => buildDownloadUrl({ R2_PUBLIC_BASE_URL: "https://files.example.com/base" }, "exports/media/1/file.pdf"),
    /must be an origin/,
  );
  await assert.rejects(
    () => buildDownloadUrl(downloadEnv(), "private/file.pdf"),
    /Only exported objects/,
  );
});

test("buildContentDisposition outputs compliant ASCII and UTF-8 encoded filename", () => {
  const cd = buildContentDisposition("中文 测试 (test).pdf");
  assert.match(cd, /attachment;/);
  assert.match(cd, /filename\*=UTF-8''%E4%B8%AD%E6%96%87%20%E6%B5%8B%E8%AF%95%20\(test\)\.pdf/);
});

test("ImaKnowledge.exportSource streams binary file into a unique R2 object and returns direct R2 URL", async () => {
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
    assert.strictEqual(url.origin, "https://ima-files.example.com");
    assert.strictEqual(url.pathname, encodedObjectPath(result.key));
    assert.strictEqual(url.search, "");

    const stored = mockR2.store.get(result.key);
    assert.ok(stored);
    assert.strictEqual(stored.options?.httpMetadata?.contentType, "application/pdf");
    assert.match(stored.options?.httpMetadata?.contentDisposition, /my_document\.pdf/);
  } finally {
    restore();
  }
});

test("ImaNotes.exportNote exports markdown note to unique R2 object and returns direct R2 URL", async () => {
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
    assert.strictEqual(new URL(result.download_url).pathname, encodedObjectPath(result.key));

    const stored = mockR2.store.get(result.key);
    assert.ok(stored);
    const text = new TextDecoder().decode(stored.data as Uint8Array);
    assert.strictEqual(text, noteMarkdown);
  } finally {
    restore();
  }
});

test("ImaKnowledge.exportSource delegates note-type media_id to direct R2 note export", async () => {
  const mockR2 = createMockR2Bucket();
  const env: Env = downloadEnv({
    R2_BUCKET: mockR2 as any,
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
    assert.match(result.download_url, /^https:\/\/ima-files\.example\.com\/exports\//);
    assert.strictEqual(new URL(result.download_url).search, "");
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource with R2 returns a direct R2 download_url for binary media", async () => {
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
    assert.match(result.download_url ?? "", /^https:\/\/ima-files\.example\.com\/exports\//);
    assert.strictEqual(new URL(result.download_url!).search, "");
    assert.strictEqual(result.is_end, true);
    assert.strictEqual(result.content, undefined);
  } finally {
    restore();
  }
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
