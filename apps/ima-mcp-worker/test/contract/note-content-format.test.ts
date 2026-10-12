import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaKnowledge, ImaNotes } from "../../src/ima.ts";
import { MediaType } from "../../src/types.ts";
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

const escapedMarkdown =
  "# Title\n\n![img](https://ima-notebook-prod.image.myqcloud.com/p?Expires=1\\&Signature=ab)\n[link](https://ima.qq.com/n?a=1\\&b=2)";
const unescapedMarkdown =
  "# Title\n\n![img](https://ima-notebook-prod.image.myqcloud.com/p?Expires=1&Signature=ab)\n[link](https://ima.qq.com/n?a=1&b=2)";
const plaintext = "Title visible text without images";
const jsonBlocks = '[{"type":"img","url":"https://ima-notebook-prod.image.myqcloud.com/p?Expires=1&Signature=ab"}]';

function okDoc(content: string) {
  return new Response(
    JSON.stringify({ code: 0, msg: "ok", data: { content } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

test("ImaNotes.get defaults to Markdown format 1 and unescapes \\& in URLs", async () => {
  const { captured, restore } = setupMockFetch((req) => {
    assert.ok(req.url.endsWith("get_doc_content"));
    return okDoc(escapedMarkdown);
  });

  try {
    const notes = new ImaNotes(new ImaClient(mockEnv, mockCreds));
    const result = await notes.get("note_1");
    assert.strictEqual(captured[0].body.note_id, "note_1");
    assert.strictEqual(captured[0].body.target_content_format, 1);
    assert.strictEqual(result.content, unescapedMarkdown);
  } finally {
    restore();
  }
});

test("ImaNotes.get forwards explicit plaintext format 0 without unescaping", async () => {
  const { captured, restore } = setupMockFetch((req) => {
    assert.strictEqual(req.body.target_content_format, 0);
    return okDoc(plaintext);
  });

  try {
    const notes = new ImaNotes(new ImaClient(mockEnv, mockCreds));
    const result = await notes.get("note_1", 0);
    assert.strictEqual(result.content, plaintext);
    assert.strictEqual(captured.length, 1);
  } finally {
    restore();
  }
});

test("ImaNotes.get forwards JSON format 2 without rewriting content", async () => {
  const { captured, restore } = setupMockFetch((req) => {
    assert.strictEqual(req.body.target_content_format, 2);
    return okDoc(jsonBlocks);
  });

  try {
    const notes = new ImaNotes(new ImaClient(mockEnv, mockCreds));
    const result = await notes.get("note_1", 2);
    assert.strictEqual(result.content, jsonBlocks);
    assert.strictEqual(captured[0].body.target_content_format, 2);
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource note path uses Markdown format by default", async () => {
  const { captured, restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: { media_type: MediaType.Note, notebook_ext_info: { notebook_id: "note_abc_123" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.endsWith("get_doc_content")) {
      return okDoc(escapedMarkdown);
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const result = await new ImaKnowledge(mockEnv, client).readSource("media_note_1", new ImaNotes(client));
    const docReq = captured.find((r) => r.url.endsWith("get_doc_content"));
    assert.ok(docReq);
    assert.strictEqual(docReq.body.note_id, "note_abc_123");
    assert.strictEqual(docReq.body.target_content_format, 1);
    assert.strictEqual(result.content, unescapedMarkdown);
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource note path forwards target_content_format 0", async () => {
  const { captured, restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: { media_type: MediaType.Note, notebook_ext_info: { notebook_id: "note_abc_123" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.endsWith("get_doc_content")) {
      return okDoc(plaintext);
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const result = await new ImaKnowledge(mockEnv, client).readSource("media_note_1", new ImaNotes(client), {
      target_content_format: 0,
    });
    const docReq = captured.find((r) => r.url.endsWith("get_doc_content"));
    assert.ok(docReq);
    assert.strictEqual(docReq.body.target_content_format, 0);
    assert.strictEqual(result.content, plaintext);
  } finally {
    restore();
  }
});
