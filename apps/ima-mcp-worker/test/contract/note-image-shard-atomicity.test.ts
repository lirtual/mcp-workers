import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient } from "../../src/ima.ts";
import { RefreshingImaNotes } from "../../src/exporting-notes.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch } from "../helpers/mock-fetch.ts";

const credentials: ImaCredentials = { clientId: "test_client", apiKey: "test_key" };

function imageUrl(path: string) {
  return `https://ima-notebook-prod.image.myqcloud.com${path}?q-sign-time=1%3B2&q-signature=expired`;
}

test("note export rejects incomplete shard results before writing R2", async () => {
  const path = "/2/user/incomplete";
  const oldUrl = imageUrl(path);
  const store = new Map<string, Uint8Array>();
  const env: Env = {
    R2_BUCKET: {
      async put(key: string, value: Uint8Array) {
        store.set(key, value);
        return { key, size: value.byteLength };
      },
    } as any,
    R2_PUBLIC_BASE_URL: "https://cdn.example.com",
    IMA_BASE_URL: "https://ima.qq.com",
    IMA_IMAGE_REFRESH_SHARD: {
      newUniqueId() { return {} as any; },
      get() {
        return {
          async processBatch() { return []; },
        } as any;
      },
    } as any,
  };

  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 1) {
      return new Response(JSON.stringify({ code: 0, data: { content: `![img](${oldUrl})` } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.url.endsWith("get_doc_content") && req.body.target_content_format === 2) {
      return new Response(JSON.stringify({
        code: 0,
        data: { content: JSON.stringify([{ type: "cloud_image", mediaId: "media_1", cosKey: path }]) },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const notes = new RefreshingImaNotes(new ImaClient(env, credentials));
    await assert.rejects(() => notes.exportNote("note_incomplete"), /shard 返回结果数量不完整/);
    assert.strictEqual(store.size, 0);
  } finally {
    restore();
  }
});
