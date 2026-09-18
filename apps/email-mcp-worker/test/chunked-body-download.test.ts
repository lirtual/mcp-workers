import { describe, expect, it } from "vitest";
import type { ImapFlow } from "imapflow";
import {
  downloadReadableBodyPart,
  preferredReadableBodyPart,
  type ReadableBodyPart,
} from "../src/imap-smtp-provider.js";

describe("bounded body-part download", () => {
  it("prefers text/plain and falls back to text/html", () => {
    const html: ReadableBodyPart = {
      part: "2",
      mediaType: "text/html",
      size: 100,
    };
    const text: ReadableBodyPart = {
      part: "1",
      mediaType: "text/plain",
      size: 200,
    };

    expect(preferredReadableBodyPart([html, text])).toEqual(text);
    expect(preferredReadableBodyPart([html])).toEqual(html);
    expect(preferredReadableBodyPart([])).toBeUndefined();
  });

  it("uses ImapFlow chunked download with a bounded decoded payload", async () => {
    const calls: unknown[] = [];
    const client = {
      async download(range: unknown, part: unknown, options: unknown) {
        calls.push({ range, part, options });
        return {
          meta: { contentType: "text/plain", charset: "utf-8" },
          content: {
            async *[Symbol.asyncIterator]() {
              yield new TextEncoder().encode("hello ");
              yield new TextEncoder().encode("from qq");
            },
          },
        };
      },
    } as unknown as Pick<ImapFlow, "download">;

    const result = await downloadReadableBodyPart(client, 42, {
      part: "1.2",
      mediaType: "text/plain",
      charset: "utf-8",
      size: 12,
    });

    expect(calls).toEqual([
      {
        range: 42,
        part: "1.2",
        options: {
          uid: true,
          chunkSize: 64 * 1024,
          maxBytes: 256 * 1024 + 1,
        },
      },
    ]);
    expect(result.body).toMatchObject({
      text: "hello from qq",
      truncated: false,
      untrusted_external_content: true,
    });
  });
});
