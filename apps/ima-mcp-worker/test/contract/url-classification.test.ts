import test from "node:test";
import assert from "node:assert/strict";
import { classifyUrl, classifyUrlWithProbe, isBlockedHost } from "../../src/url.ts";
import { setupMockFetch } from "../helpers/mock-fetch.ts";

test("isBlockedHost correctly identifies private, loopback, and internal hosts", () => {
  assert.strictEqual(isBlockedHost("localhost"), true);
  assert.strictEqual(isBlockedHost("sub.localhost"), true);
  assert.strictEqual(isBlockedHost("server.local"), true);
  assert.strictEqual(isBlockedHost("internal.corp"), false); // endsWith .internal check
  assert.strictEqual(isBlockedHost("corp.internal"), true);
  assert.strictEqual(isBlockedHost("127.0.0.1"), true);
  assert.strictEqual(isBlockedHost("10.0.0.1"), true);
  assert.strictEqual(isBlockedHost("192.168.1.1"), true);
  assert.strictEqual(isBlockedHost("172.16.0.1"), true);
  assert.strictEqual(isBlockedHost("172.31.255.255"), true);
  assert.strictEqual(isBlockedHost("169.254.1.1"), true);
  assert.strictEqual(isBlockedHost("::1"), true);
  assert.strictEqual(isBlockedHost("fc00::1"), true);
  assert.strictEqual(isBlockedHost("fd12:3456::1"), true);
  assert.strictEqual(isBlockedHost("fe80::1"), true);

  // Safe public hosts, including DNS names that merely begin with IPv6-like prefixes.
  assert.strictEqual(isBlockedHost("ima.qq.com"), false);
  assert.strictEqual(isBlockedHost("mp.weixin.qq.com"), false);
  assert.strictEqual(isBlockedHost("arxiv.org"), false);
  assert.strictEqual(isBlockedHost("8.8.8.8"), false);
  assert.strictEqual(isBlockedHost("fc-example.com"), false);
  assert.strictEqual(isBlockedHost("fd.example.com"), false);
  assert.strictEqual(isBlockedHost("fe80-public.example"), false);
});

test("classifyUrl does not apply IPv6 prefix rules to ordinary DNS names", () => {
  const result = classifyUrl("https://fc-example.com/article");
  assert.strictEqual(result.isSafeHttps, true);
  assert.strictEqual(result.type, "web");
  assert.strictEqual(result.suggestedAction, "import_urls");
});

test("classifyUrl rejects non-HTTPS schemes", () => {
  const fileRes = classifyUrl("file:///home/user/doc.pdf");
  assert.strictEqual(fileRes.isSafeHttps, false);
  assert.strictEqual(fileRes.type, "local_unsupported");
  assert.match(fileRes.reason || "", /ima 桌面端/);

  const httpRes = classifyUrl("http://example.com/article");
  assert.strictEqual(httpRes.isSafeHttps, false);
  assert.strictEqual(httpRes.type, "unsupported");
  assert.match(httpRes.reason || "", /https:\/\//);

  const ftpRes = classifyUrl("ftp://files.example.com/data.csv");
  assert.strictEqual(ftpRes.isSafeHttps, false);
  assert.strictEqual(ftpRes.type, "unsupported");
});

test("classifyUrl blocks SSRF and private hosts", () => {
  const localRes = classifyUrl("https://localhost:8080/doc");
  assert.strictEqual(localRes.isSafeHttps, false);
  assert.match(localRes.reason || "", /内网/);

  const privateRes = classifyUrl("https://192.168.1.100/admin");
  assert.strictEqual(privateRes.isSafeHttps, false);
  assert.match(privateRes.reason || "", /内网/);
});

test("classifyUrl rejects video URLs with desktop guidance", () => {
  const biliRes = classifyUrl("https://www.bilibili.com/video/BV1xx411c7mD");
  assert.strictEqual(biliRes.type, "video_unsupported");
  assert.match(biliRes.reason || "", /ima 桌面端/);

  const ytRes = classifyUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.strictEqual(ytRes.type, "video_unsupported");
  assert.match(ytRes.reason || "", /ima 桌面端/);
});

test("classifyUrl identifies WeChat articles and standard web pages for import_urls", () => {
  const wxRes = classifyUrl("https://mp.weixin.qq.com/s/xyz123_abc");
  assert.strictEqual(wxRes.isSafeHttps, true);
  assert.strictEqual(wxRes.type, "wechat");
  assert.strictEqual(wxRes.suggestedAction, "import_urls");

  const webRes = classifyUrl("https://example.com/blog/2026/future");
  assert.strictEqual(webRes.isSafeHttps, true);
  assert.strictEqual(webRes.type, "web");
  assert.strictEqual(webRes.suggestedAction, "import_urls");
});

test("classifyUrl identifies downloadable files and routes to upload_file", () => {
  const arxivRes = classifyUrl("https://arxiv.org/pdf/2301.00001.pdf");
  assert.strictEqual(arxivRes.isSafeHttps, true);
  assert.strictEqual(arxivRes.type, "file_download");
  assert.strictEqual(arxivRes.suggestedAction, "upload_file");

  const docxRes = classifyUrl("https://example.com/files/specs.docx");
  assert.strictEqual(docxRes.isSafeHttps, true);
  assert.strictEqual(docxRes.type, "file_download");
  assert.strictEqual(docxRes.suggestedAction, "upload_file");
});

test("classifyUrlWithProbe detects extensionless file downloads via Content-Type and Content-Disposition", async () => {
  const { restore } = setupMockFetch(req => {
    if (req.url === "https://example.com/api/v1/download/document") {
      return new Response("", {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="annual_report.pdf"',
        },
      });
    }
    return new Response("Not found", { status: 404 });
  });

  try {
    const res = await classifyUrlWithProbe("https://example.com/api/v1/download/document");
    assert.strictEqual(res.type, "file_download");
    assert.strictEqual(res.suggestedAction, "upload_file");
    assert.strictEqual(res.inferredFileName, "annual_report.pdf");
  } finally {
    restore();
  }
});

test("classifyUrlWithProbe rejects a redirect to a blocked host before following it", async () => {
  const requested: string[] = [];
  const { restore } = setupMockFetch(req => {
    requested.push(req.url);
    if (req.url === "https://example.com/download") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private.pdf" },
      });
    }
    throw new Error("blocked redirect target must not be fetched");
  });

  try {
    const result = await classifyUrlWithProbe("https://example.com/download");
    assert.strictEqual(result.suggestedAction, "reject");
    assert.match(result.reason || "", /内网|安全/);
    assert.deepStrictEqual(requested, ["https://example.com/download"]);
  } finally {
    restore();
  }
});
