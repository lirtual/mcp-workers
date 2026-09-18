import { describe, expect, it } from "vitest";
import type { MessageStructureObject } from "imapflow";
import {
  normalizeFetchedBodyParts,
  parseReferencesHeader,
  selectReadableBodyParts,
} from "../src/imap-smtp-provider.js";

function structure(): MessageStructureObject {
  return {
    type: "multipart/alternative",
    childNodes: [
      {
        part: "1",
        type: "text/plain",
        encoding: "base64",
        size: 32,
        parameters: { charset: "utf-8" },
      },
      {
        part: "2",
        type: "text/html",
        encoding: "quoted-printable",
        size: 64,
        parameters: { charset: "utf-8" },
      },
      {
        part: "3",
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "report.pdf" },
        size: 1000,
      },
    ],
  };
}

describe("email_get body-part selection", () => {
  it("selects bounded text/plain and text/html parts but never attachments", () => {
    expect(selectReadableBodyParts(structure())).toEqual([
      {
        part: "1",
        mediaType: "text/plain",
        charset: "utf-8",
        encoding: "base64",
        size: 32,
      },
      {
        part: "2",
        mediaType: "text/html",
        charset: "utf-8",
        encoding: "quoted-printable",
        size: 64,
      },
    ]);
  });

  it("skips oversized text parts instead of requesting unbounded content", () => {
    const oversized: MessageStructureObject = {
      type: "multipart/alternative",
      childNodes: [
        {
          part: "1",
          type: "text/plain",
          size: 2 * 1024 * 1024,
          parameters: { charset: "utf-8" },
        },
      ],
    };
    expect(selectReadableBodyParts(oversized)).toEqual([]);
  });

  it("decodes transfer encoding and charset through the bounded MIME normalizer", async () => {
    const parts = selectReadableBodyParts(structure());
    const fetched = new Map<string, Uint8Array>([
      ["1", new TextEncoder().encode("SGVsbG8g5LiW55WM")],
      ["2", new TextEncoder().encode("<p>Hello=20HTML</p>")],
    ]);

    await expect(normalizeFetchedBodyParts(parts, fetched)).resolves.toMatchObject({
      body: {
        text: "Hello 世界",
        html: "<p>Hello HTML</p>",
        truncated: false,
        untrusted_external_content: true,
      },
    });
  });

  it("parses and unfolds References without requiring full RFC822 source", () => {
    expect(
      parseReferencesHeader(
        new TextEncoder().encode(
          "References: <root@example.com>\r\n\t<parent@example.com>\r\n\r\n",
        ),
      ),
    ).toBe("<root@example.com> <parent@example.com>");
  });
});
