import test from "node:test";
import assert from "node:assert/strict";
import { resolveUploadMetadata } from "../../src/preflight.ts";

test("resolveUploadMetadata respects Content-Type first priority over misleading extension", () => {
  // A markdown file named with .txt extension or .bin
  const meta = resolveUploadMetadata({
    fileName: "notes.txt",
    contentType: "text/markdown",
    fileSize: 1024,
  });
  assert.strictEqual(meta.mediaType, 7); // Markdown wins
  assert.strictEqual(meta.contentType, "text/markdown");
  assert.strictEqual(meta.fileExt, "txt");
});

test("resolveUploadMetadata handles extensionless files with valid content-type", () => {
  const meta = resolveUploadMetadata({
    fileName: "downloaded_document",
    contentType: "application/pdf",
    fileSize: 50000,
  });
  assert.strictEqual(meta.mediaType, 1);
  assert.strictEqual(meta.contentType, "application/pdf");
  assert.strictEqual(meta.fileExt, "pdf"); // inferred when missing
});

test("resolveUploadMetadata supports content-type aliases", () => {
  const meta1 = resolveUploadMetadata({
    fileName: "doc",
    contentType: "text/x-markdown",
    fileSize: 100,
  });
  assert.strictEqual(meta1.mediaType, 7);

  const meta2 = resolveUploadMetadata({
    fileName: "mindmap",
    contentType: "application/vnd.xmind.workbook",
    fileSize: 200,
  });
  assert.strictEqual(meta2.mediaType, 14);
});

test("resolveUploadMetadata enforces application/zip only for .xmind", () => {
  // .xmind with application/zip passes
  const valid = resolveUploadMetadata({
    fileName: "brainstorm.xmind",
    contentType: "application/zip",
    fileSize: 1000,
  });
  assert.strictEqual(valid.mediaType, 14);

  // generic .zip fails
  assert.throws(
    () => resolveUploadMetadata({ fileName: "archive.zip", contentType: "application/zip", fileSize: 1000 }),
    /Generic ZIP files are not supported/i
  );
});

test("resolveUploadMetadata rejects unsupported video types", () => {
  assert.throws(
    () => resolveUploadMetadata({ fileName: "movie.mp4", fileSize: 1000 }),
    /Video files .* are not supported as uploads/i
  );
  assert.throws(
    () => resolveUploadMetadata({ fileName: "video_file", contentType: "video/webm", fileSize: 1000 }),
    /Video content .* not supported as upload/i
  );
});

test("resolveUploadMetadata rejects non-file types with import_urls hint", () => {
  assert.throws(
    () => resolveUploadMetadata({ fileName: "page.mhtml", fileSize: 1000 }),
    /import_urls/i
  );
  assert.throws(
    () => resolveUploadMetadata({ fileName: "page", contentType: "application/xhtml+xml", fileSize: 1000 }),
    /import_urls/i
  );
});

test("resolveUploadMetadata enforces size limits per media type", () => {
  const MB = 1024 * 1024;
  // Markdown limit: 10MB
  assert.throws(
    () => resolveUploadMetadata({ fileName: "large.md", fileSize: 11 * MB }),
    /exceeds the 10\.0 MB limit/i
  );

  // PDF limit: 200MB - 150MB should pass
  const pdf = resolveUploadMetadata({ fileName: "paper.pdf", fileSize: 150 * MB });
  assert.strictEqual(pdf.mediaType, 1);

  // PDF limit: 200MB - 201MB should fail
  assert.throws(
    () => resolveUploadMetadata({ fileName: "paper.pdf", fileSize: 201 * MB }),
    /exceeds the 200\.0 MB limit/i
  );
});
