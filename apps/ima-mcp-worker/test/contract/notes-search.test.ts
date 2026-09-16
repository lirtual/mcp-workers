import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaNotes } from "../../src/ima.ts";
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

test("ImaNotes.search sends DOC_TITLE query_info when search_type is 0 or omitted", async () => {
  const { captured, restore } = setupMockFetch(req => {
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          search_note_infos: [],
          is_end: true,
          total_hit_num: 0,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);

    await notes.search({ query: "architecture plan" });

    assert.strictEqual(captured.length, 1);
    const req = captured[0];
    assert.strictEqual(req.url, "https://ima.qq.com/openapi/note/v1/search_note");
    assert.strictEqual(req.method, "POST");
    assert.strictEqual(req.headers["ima-openapi-clientid"], "test_client_id");
    assert.strictEqual(req.headers["ima-openapi-apikey"], "test_api_key");

    // Authoritative API schema check:
    // search_type = 0 (DOC_TITLE) must send query_info: { title: "architecture plan" }
    assert.strictEqual(req.body.search_type, 0);
    assert.deepStrictEqual(req.body.query_info, { title: "architecture plan" });
    assert.strictEqual(req.body.start, 0);
    assert.strictEqual(req.body.end, 20);
  } finally {
    restore();
  }
});

test("ImaNotes.search sends DOC_CONTENT query_info when search_type is 1", async () => {
  const { captured, restore } = setupMockFetch(req => {
    return new Response(
      JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          search_note_infos: [],
          is_end: true,
          total_hit_num: 0,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);

    await notes.search({ query: "machine learning details", search_type: 1, start: 20, end: 40 });

    assert.strictEqual(captured.length, 1);
    const req = captured[0];
    assert.strictEqual(req.body.search_type, 1);
    // DOC_CONTENT must send query_info: { content: "machine learning details" }
    assert.deepStrictEqual(req.body.query_info, { content: "machine learning details" });
    assert.strictEqual(req.body.start, 20);
    assert.strictEqual(req.body.end, 40);
  } finally {
    restore();
  }
});

test("ImaNotes.search validates pagination boundaries", async () => {
  const client = new ImaClient(mockEnv, mockCreds);
  const notes = new ImaNotes(client);

  // end <= start
  await assert.rejects(
    async () => notes.search({ query: "test", start: 20, end: 10 }),
    /end must be greater than start/i
  );

  // end - start > 20
  await assert.rejects(
    async () => notes.search({ query: "test", start: 0, end: 50 }),
    /maximum page size 20/i
  );
});
