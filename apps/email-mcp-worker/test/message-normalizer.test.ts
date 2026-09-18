import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  MAX_SOURCE_BYTES,
  normalizeBodyText,
  normalizeMimeMessage,
  oversizedMessageFallback,
} from "../src/message-normalizer.js";

describe("bounded message normalization", () => {
  it("marks body content as untrusted and strips attachment bytes", async () => {
    const raw = [
      "From: Sender <sender@example.com>",
      "To: user@qq.com",
      "Subject: Hello",
      "Message-ID: <m1@example.com>",
      'Content-Type: multipart/mixed; boundary="x"',
      "",
      "--x",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "hello body",
      "--x",
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      "c2VjcmV0IGF0dGFjaG1lbnQ=",
      "--x--",
      "",
    ].join("\r\n");

    const result = await normalizeMimeMessage(new TextEncoder().encode(raw));
    expect(result.body).toMatchObject({
      truncated: false,
      untrusted_external_content: true,
    });
    expect(result.body.text?.trim()).toBe("hello body");
    expect(result.body.warning).toContain("untrusted");
    expect(result.attachments).toEqual([
      expect.objectContaining({
        filename: "note.txt",
        media_type: "text/plain",
        disposition: "attachment",
      }),
    ]);
    expect(JSON.stringify(result.attachments)).not.toContain("secret attachment");
  });

  it("truncates UTF-8 body fields to the configured byte bound", () => {
    const input = "你".repeat(MAX_BODY_BYTES);
    const result = normalizeBodyText(input);
    expect(new TextEncoder().encode(result.value).byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(result.truncated).toBe(true);
  });

  it("returns bounded metadata instead of parsing oversized raw source", () => {
    expect(MAX_SOURCE_BYTES).toBe(1024 * 1024);
    const result = oversizedMessageFallback({
      type: "multipart/mixed",
      childNodes: [
        {
          type: "application/pdf",
          part: "2",
          size: 5000000,
          disposition: "attachment",
          dispositionParameters: { filename: "large.pdf" },
        },
      ],
    });

    expect(result.body).toMatchObject({
      truncated: true,
      untrusted_external_content: true,
      body_unavailable_reason: "message_source_too_large",
    });
    expect(result.attachments).toEqual([
      {
        filename: "large.pdf",
        media_type: "application/pdf",
        disposition: "attachment",
        size_bytes: 5000000,
      },
    ]);
  });
});
