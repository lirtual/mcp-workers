import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaKnowledge, ImaNotes } from "../../src/ima.ts";
import { RefreshingImaNotes } from "../../src/exporting-notes.ts";
import { MAX_TEMP_UPLOAD_BYTES, sanitizeFileName, uploadTemporaryFile } from "../../src/temporary-upload.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch } from "../helpers/mock-fetch.ts";

const credentials: ImaCredentials = { clientId: "client", apiKey: "key" };
const env: Env = { IMA_BASE_URL: "https://ima.qq.com" };
const endpoint = "https://litterbox.catbox.moe/resources/internals/api.php";
const download = "https://litter.catbox.moe/a1b2c3.md";

function json(data: unknown) {
  return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { "content-type": "application/json" } });
}

test("temporary upload sends a 24h multipart file with sanitized filename", async () => {
  const { restore, captured } = setupMockFetch(req => {
    assert.equal(req.url, endpoint);
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], undefined); // FormData owns its boundary
    const form = req.body as FormData;
    assert.equal(form.get("reqtype"), "fileupload");
    assert.equal(form.get("time"), "24h");
    const file = form.get("fileToUpload");
    assert.ok(file instanceof File);
    assert.equal(file.name, "notes.md");
    assert.equal(file.type, "text/markdown");
    return new Response(download);
  });
  try {
    const url = await uploadTemporaryFile("../../notes.md", "text/markdown", new TextEncoder().encode("hello"));
    assert.equal(url, download);
    const file = captured[0].body.get("fileToUpload") as File;
    assert.equal(await file.text(), "hello");
  } finally { restore(); }
});

test("temporary upload validates upstream HTTP status and download URL", async () => {
  for (const [body, status] of [
    ["Service unavailable", 503],
    ["Error: file rejected", 200],
    ["https://evil.example/file.md", 200],
    ["http://litter.catbox.moe/file.md", 200],
    ["https://litter.catbox.moe.evil.example/file.md", 200],
    ["https://litter.catbox.moe/file.md?token=x", 200],
    ["https://litter.catbox.moe/path/file.md", 200],
  ] as const) {
    const { restore } = setupMockFetch(() => new Response(body, { status }));
    try {
      await assert.rejects(() => uploadTemporaryFile("a.md", "text/plain", new Uint8Array([1])), /Litterbox/);
    } finally { restore(); }
  }
});

test("temporary upload checks size before calling upstream", async () => {
  let calls = 0;
  const { restore } = setupMockFetch(() => { calls++; return new Response(download); });
  try {
    await assert.rejects(() => uploadTemporaryFile("huge.bin", "application/octet-stream", new Uint8Array(MAX_TEMP_UPLOAD_BYTES + 1)), /32 MiB/);
    assert.equal(calls, 0);
  } finally { restore(); }
});

test("temporary file name sanitization is consistent", () => {
  assert.equal(sanitizeFileName("../../evil.md"), "evil.md");
  assert.equal(sanitizeFileName("  weird/dir/foo", "md"), "foo.md");
  assert.equal(sanitizeFileName("", "pdf"), "exported_file.pdf");
});

test("plain and refreshing note exports upload markdown, without storage bindings", async () => {
  const uploads: File[] = [];
  const { restore } = setupMockFetch(req => {
    if (req.url.endsWith("get_doc_content")) return json({ content: "# Hello\nText" });
    if (req.url === endpoint) {
      uploads.push((req.body as FormData).get("fileToUpload") as File);
      return new Response(download);
    }
    return new Response("not found", { status: 404 });
  });
  try {
    const api = new ImaClient(env, credentials);
    for (const notes of [new ImaNotes(api), new RefreshingImaNotes(api)]) {
      const result = await notes.exportNote("note_42");
      assert.equal(result.download_url, download);
      assert.equal(result.expires_in, "24h");
      assert.equal(result.file_name, "Hello.md");
      assert.equal(result.note_id, "note_42");
    }
    assert.equal(uploads.length, 2);
    assert.equal(await uploads[0].text(), "# Hello\nText");
  } finally { restore(); }
});

test("knowledge binary export uses temporary upload and preserves file contents", async () => {
  let uploadCount = 0;
  const payload = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const { restore } = setupMockFetch(req => {
    if (req.url.endsWith("get_media_info")) {
      return json({ media_type: 1, url_info: { url: "https://download.ima.qq.com/a.pdf", headers: { authorization: "secret" } } });
    }
    if (req.url === "https://download.ima.qq.com/a.pdf") {
      assert.equal(req.headers.authorization, "secret");
      return new Response(payload, { headers: { "content-type": "application/pdf", "content-length": String(payload.byteLength) } });
    }
    if (req.url === endpoint) {
      uploadCount++;
      const file = (req.body as FormData).get("fileToUpload") as File;
      assert.equal(file.name, "a.pdf");
      assert.equal(file.type, "application/pdf");
      return new Response(download);
    }
    return new Response("not found", { status: 404 });
  });
  try {
    const api = new ImaClient(env, credentials);
    const kb = new ImaKnowledge(env, api);
    const notes = new ImaNotes(api);
    const first = await kb.readSource("media_pdf", notes, { offset: 0, max_bytes: 4 });
    assert.equal(first.download_url, undefined);
    assert.equal(uploadCount, 0);
    const second = await kb.readSource("media_pdf", notes, { export_to_temporary: true });
    assert.equal(second.download_url, download);
    assert.equal(second.expires_in, "24h");
    assert.equal(uploadCount, 1);
    const explicit = await kb.exportSource("media_pdf", notes);
    assert.equal(explicit.file_size, payload.byteLength);
    assert.equal(uploadCount, 2);
  } finally { restore(); }
});

test("oversized content-length fails without uploading", async () => {
  let uploadCount = 0;
  const { restore } = setupMockFetch(req => {
    if (req.url.endsWith("get_media_info")) return json({ media_type: 1, url_info: { url: "https://download.ima.qq.com/large.pdf" } });
    if (req.url === "https://download.ima.qq.com/large.pdf") return new Response("small", { headers: { "content-length": String(MAX_TEMP_UPLOAD_BYTES + 1) } });
    if (req.url === endpoint) uploadCount++;
    return new Response("not found", { status: 404 });
  });
  try {
    const api = new ImaClient(env, credentials);
    await assert.rejects(() => new ImaKnowledge(env, api).exportSource("large", new ImaNotes(api)), /32 MiB/);
    assert.equal(uploadCount, 0);
  } finally { restore(); }
});
