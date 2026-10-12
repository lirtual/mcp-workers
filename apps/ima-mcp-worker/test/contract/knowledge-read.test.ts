import test from "node:test";
import assert from "node:assert/strict";
import { ImaClient, ImaKnowledge, ImaNotes } from "../../src/ima.ts";
import { MediaType } from "../../src/types.ts";
import type { Env, ImaCredentials } from "../../src/types.ts";
import { setupMockFetch } from "../helpers/mock-fetch.ts";
import { bufferToBase64 } from "../../src/stream.ts";

const mockEnv: Env = {
  DB: {} as any,
  IMA_BASE_URL: "https://ima.qq.com",
  FILE_DOWNLOAD_TIMEOUT_MS: "5000",
};

const mockCreds: ImaCredentials = {
  clientId: "test_client_id",
  apiKey: "test_api_key",
};

test("ImaKnowledge.readSource retrieves note content when media_type is 11 (Note)", async () => {
  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_type: MediaType.Note,
            notebook_ext_info: { notebook_id: "note_abc_123" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url.endsWith("get_doc_content")) {
      assert.strictEqual(req.body.note_id, "note_abc_123");
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            content: "This is the note content from IMA.",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(mockEnv, client);

    const result = await kb.readSource("media_note_1", notes);
    assert.strictEqual(result.media_id, "media_note_1");
    assert.strictEqual(result.media_type, MediaType.Note);
    assert.strictEqual(result.content, "This is the note content from IMA.");
    // Standards check: raw_info is stripped
    assert.strictEqual((result as any).raw_info, undefined);
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource fetches text URL content with custom headers and never leaks token headers", async () => {
  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_type: MediaType.Web,
            url_info: {
              url: "https://download.ima.qq.com/articles/article1.txt",
              headers: { "x-ima-token": "secret_temporary_token" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url === "https://download.ima.qq.com/articles/article1.txt") {
      assert.strictEqual(req.headers["x-ima-token"], "secret_temporary_token");
      return new Response("Full article text content", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(mockEnv, client);

    const result = await kb.readSource("media_article_1", notes);
    assert.strictEqual(result.media_id, "media_article_1");
    assert.strictEqual(result.media_type, MediaType.Web);
    assert.strictEqual(result.content, "Full article text content");
    assert.strictEqual(result.is_end, true);
    assert.strictEqual(result.url, "https://download.ima.qq.com/articles/article1.txt");

    // Standards 1 Verification: No raw_info, no url_info headers leaked in return object
    assert.strictEqual((result as any).raw_info, undefined);
    assert.strictEqual((result as any).url_info, undefined);
    assert.strictEqual((result as any).headers, undefined);
    assert(!JSON.stringify(result).includes("secret_temporary_token"));
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource converts small binary images into base64 data URL", async () => {
  const smallBinaryBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_type: MediaType.Image,
            url_info: {
              url: "https://download.ima.qq.com/images/pic.png",
              headers: { "x-token": "tok" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url === "https://download.ima.qq.com/images/pic.png") {
      return new Response(smallBinaryBytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(smallBinaryBytes.length),
        },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(mockEnv, client);

    const result = await kb.readSource("media_img_1", notes);
    assert.strictEqual(result.media_id, "media_img_1");
    assert.strictEqual(result.media_type, MediaType.Image);
    assert(result.content?.startsWith("data:image/png;base64,"));
    // No raw_info
    assert.strictEqual((result as any).raw_info, undefined);
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource returns a bounded chunk for large binary files (>2MB)", async () => {
  const chunk = new TextEncoder().encode("dummy stream");
  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_type: MediaType.EPUB,
            url_info: {
              url: "https://download.ima.qq.com/docs/large.bin",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url === "https://download.ima.qq.com/docs/large.bin") {
      return new Response(chunk, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(10 * 1024 * 1024),
        },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(mockEnv, client);

    const result = await kb.readSource("media_large_bin", notes);
    assert.strictEqual(result.media_id, "media_large_bin");
    assert.strictEqual(
      result.content,
      `data:application/octet-stream;base64,${bufferToBase64(chunk)}`,
    );
    assert.strictEqual(result.offset, 0);
    assert.strictEqual(result.bytes_returned, chunk.byteLength);
    assert.strictEqual(result.next_offset, chunk.byteLength);
    assert.strictEqual(result.is_end, false);
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource supports authenticated binary range pagination", async () => {
  const bytes = new TextEncoder().encode("abcdefghij");
  const seenRanges: string[] = [];
  const { restore } = setupMockFetch(req => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          media_type: MediaType.EPUB,
          url_info: {
            url: "https://download.ima.qq.com/docs/ranged.bin",
            headers: { authorization: "temporary-secret" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const range = req.headers.range || "";
    seenRanges.push(range);
    assert.strictEqual(req.headers.authorization, "temporary-secret");
    return new Response(bytes.slice(4, 8), {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-range": "bytes 4-7/10",
      },
    });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const result = await new ImaKnowledge(mockEnv, client).readSource(
      "media_ranged",
      new ImaNotes(client),
      { offset: 4, max_bytes: 4 }
    );
    assert.deepStrictEqual(seenRanges, ["bytes=4-7"]);
    assert.strictEqual(
      result.content,
      `data:application/octet-stream;base64,${bufferToBase64(bytes.slice(4, 8))}`,
    );
    assert.strictEqual(result.next_offset, 8);
    assert.strictEqual(result.is_end, false);
    assert(!JSON.stringify(result).includes("temporary-secret"));
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource returns graceful fallback message for unavailable media", async () => {
  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            media_type: MediaType.PDF, // PDF without direct URL
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(mockEnv, client);

    const result = await kb.readSource("media_pdf_1", notes);
    assert.strictEqual(result.media_id, "media_pdf_1");
    assert.strictEqual(result.media_type, MediaType.PDF);
    assert.strictEqual(result.content, undefined);
    assert.match(result.fallback_message || "", /IMA 客户端查看/);
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource paginates oversized text instead of treating a 206 body as complete", async () => {
  const full = "ABCDEFGHIJabcdefghij";
  const seenRanges: string[] = [];
  const { restore } = setupMockFetch((req) => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            media_type: MediaType.Web,
            url_info: { url: "https://download.ima.qq.com/articles/long.txt" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (req.url === "https://download.ima.qq.com/articles/long.txt") {
      const range = req.headers.range || "";
      seenRanges.push(range);
      const match = range.match(/^bytes=(\d+)-(\d+)$/);
      const start = match ? Number(match[1]) : 0;
      const end = match ? Number(match[2]) : start;
      const slice = full.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-range": `bytes ${start}-${start + slice.length - 1}/${full.length}`,
        },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(mockEnv, client);

    const first = await kb.readSource("media_long_text", notes, { max_bytes: 8 });
    assert.strictEqual(first.content, "ABCDEFGH");
    assert.strictEqual(first.is_end, false);
    assert.strictEqual(first.next_offset, 8);
    assert.strictEqual(first.bytes_returned, 8);
    assert.deepStrictEqual(seenRanges, ["bytes=0-7"]);

    const second = await kb.readSource("media_long_text", notes, { offset: first.next_offset, max_bytes: 8 });
    assert.strictEqual(second.content, "IJabcdef");
    assert.strictEqual(second.is_end, false);
    assert.strictEqual(second.next_offset, 16);

    const third = await kb.readSource("media_long_text", notes, { offset: second.next_offset, max_bytes: 8 });
    assert.strictEqual(third.content, "ghij");
    assert.strictEqual(third.is_end, true);
    assert.strictEqual(third.next_offset, undefined);
    assert.deepStrictEqual(seenRanges, ["bytes=0-7", "bytes=8-15", "bytes=16-23"]);
  } finally {
    restore();
  }
});

test("ImaKnowledge.readSource never fetches a blocked media URL", async () => {
  let blockedTargetFetched = false;
  const { restore } = setupMockFetch(req => {
    if (req.url.endsWith("get_media_info")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          media_type: 2,
          url_info: { url: "https://127.0.0.1/private", headers: { authorization: "secret" } },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    blockedTargetFetched = true;
    return new Response("private", { status: 200, headers: { "content-type": "text/plain" } });
  });

  try {
    const client = new ImaClient(mockEnv, mockCreds);
    const notes = new ImaNotes(client);
    const kb = new ImaKnowledge(mockEnv, client);
    const result = await kb.readSource("media_private", notes);
    assert.strictEqual(blockedTargetFetched, false);
    assert.match(result.fallback_message || "", /无法直接.*获取原文/);
  } finally {
    restore();
  }
});

test("ImaKnowledge.media strips temporary request headers from public metadata", async () => {
  const { restore } = setupMockFetch(() => new Response(JSON.stringify({
    code: 0,
    data: {
      media_type: MediaType.PDF,
      url_info: {
        url: "https://download.ima.qq.com/docs/file.pdf",
        headers: { authorization: "temporary-secret", "x-ima-token": "also-secret" },
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } }));

  try {
    const result = await new ImaKnowledge(mockEnv, new ImaClient(mockEnv, mockCreds)).media("media_1");
    assert.deepStrictEqual(result.url_info, { url: "https://download.ima.qq.com/docs/file.pdf" });
    assert(!JSON.stringify(result).includes("secret"));
  } finally {
    restore();
  }
});
