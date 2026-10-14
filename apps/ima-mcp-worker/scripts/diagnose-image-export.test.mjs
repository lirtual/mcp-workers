import test from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "./diagnose-image-export.mjs";

const noteId = "7504020583223963";
const credentials = { clientId: "private-client-id", apiKey: "private-api-key" };
const HOST = "https://ima-notebook-prod.image.myqcloud.com";

function json(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

test("compares exact Markdown image path coverage across two format=2 sources", async () => {
  const called = [];
  const transport = async (input, options) => {
    const u = String(input);
    called.push({ host: new URL(u).hostname, path: new URL(u).pathname, method: options.method });
    if (u.endsWith("/get_doc_content")) {
      const format = JSON.parse(options.body).target_content_format;
      if (format === 1) {
        const md = [
          `![good](${HOST}/2/good?q-sign-time=1%3B2\&q-signature=private)`,
          `![old](${HOST}/2/old?q-sign-time=1%3B2)`,
          `![same-old](${HOST}/2/old?q-sign-time=1%3B2)`,
        ].join("\n");
        return json({ code: 0, data: { content: md } });
      }
      assert.equal(format, 2);
      return json({ code: 0, data: { content: JSON.stringify([
        { type: "cloud_image", mediaId: "private-media-id", cosKey: "/2/good", url: HOST + "/2/good" },
        { type: "cloud_image", url: HOST + "/2/old" },
      ]) } });
    }
    if (u.endsWith("/export_note")) {
      assert.equal(JSON.parse(options.body).target_content_format, 2);
      return json({ code: 0, data: { content_url: "https://example.cos.ap-guangzhou.myqcloud.com/download?secret=private-download" } });
    }
    if (u.includes("example.cos.ap-guangzhou.myqcloud.com")) {
      return new Response(JSON.stringify([
        { type: "cloud_image", mediaId: "private-export-id", cosKey: "/2/old" },
        { type: "cloud_image", mediaId: "private-media-id", cosKey: "/2/good" },
      ]), { status: 200 });
    }
    if (u.endsWith("/export_media_for_ima_sandbox")) {
      assert.deepEqual(JSON.parse(options.body), { media_id: "private-media-id" });
      return json({ code: 0, data: { url_info: { url: HOST + "/2/good?q-signature=private-signature" } } });
    }
    throw new Error("Unexpected URL");
  };

  const summary = await diagnose(noteId, credentials, transport);
  assert.deepEqual(summary.operations.markdown_references, { status: "ok", distinctImagePaths: 2 });
  assert.deepEqual(summary.operations.get_doc_content, {
    status: "ok", parseable: true, total: 2, withMediaIdAndCosKey: 1,
    missingBoth: 1, legacyHostMissingBoth: 1,
    markdownImagePaths: 2, mappedMarkdownPaths: 1, unmappedMarkdownPaths: 1,
  });
  assert.deepEqual(summary.operations.export_note, {
    status: "ok", delivery: "content_url", parseable: true, total: 2,
    withMediaIdAndCosKey: 2, missingBoth: 0, legacyHostMissingBoth: 0,
    markdownImagePaths: 2, mappedMarkdownPaths: 2, unmappedMarkdownPaths: 0,
  });
  assert.equal(summary.operations.export_media_for_ima_sandbox.status, "ok");
  assert.equal(summary.operations.export_media_for_ima_sandbox.urlTrustedHost, true);
  assert.deepEqual(called.map(x => x.host),
    ["ima.qq.com", "ima.qq.com", "ima.qq.com", "example.cos.ap-guangzhou.myqcloud.com", "ima.qq.com"]);
  const result = JSON.stringify(summary);
  for (const forbidden of ["private-client-id", "private-api-key", "private-media-id", "private-download", "private-signature"]) {
    assert.equal(result.includes(forbidden), false);
  }
});

test("does not download unknown content_url host", async () => {
  const urls = [];
  const result = await diagnose(noteId, credentials, async (input, options) => {
    const u = String(input);
    urls.push(u);
    if (u.endsWith("/get_doc_content")) {
      const format = JSON.parse(options.body).target_content_format;
      return json({ code: 0, data: { content: format === 1 ? "" : "[]" } });
    }
    if (u.endsWith("/export_note")) return json({ code: 0, data: { content_url: "https://attacker.example/file" } });
    throw new Error("must not request non-IMA origins");
  });
  assert.deepEqual(result.operations.markdown_references, { status: "ok", distinctImagePaths: 0 });
  assert.equal(result.operations.export_note.status, "blocked");
  assert.equal(result.operations.export_media_for_ima_sandbox.status, "skipped_no_media_id");
  assert.equal(urls.length, 3);
});

test("reports a real permission denial as code only", async () => {
  const result = await diagnose(noteId, credentials, async (input, options) => {
    const u = String(input);
    if (u.endsWith("/get_doc_content")) {
      const format = JSON.parse(options.body).target_content_format;
      return json({ code: 0, data: { content: format === 1 ? "" : JSON.stringify([
        { type: "cloud_image", mediaId: "private-media-id", cosKey: "/2/key" },
      ]) } });
    }
    return json({ code: 220030, msg: "private error details" });
  });
  assert.deepEqual(result.operations.export_note, { status: "failed", code: 220030 });
  assert.deepEqual(result.operations.export_media_for_ima_sandbox, { status: "failed", code: 220030 });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("a non-JSON export body is not a successful media mapping result", async () => {
  const result = await diagnose(noteId, credentials, async (input, options) => {
    const u = String(input);
    if (u.endsWith("/get_doc_content")) {
      const format = JSON.parse(options.body).target_content_format;
      return json({ code: 0, data: { content: format === 1 ? `![old](${HOST}/2/old)` : "[]" } });
    }
    if (u.endsWith("/export_note")) return json({ code: 0, data: { content: "not-a-JSON-export" } });
    throw new Error("Unexpected endpoint");
  });
  assert.deepEqual(result.operations.export_note, { status: "invalid_format", delivery: "inline", parseable: false });
});
