import { describe, expect, it } from "vitest";
import {
  decodeMessageReference,
  decodeSearchCursor,
  encodeMessageReference,
  encodeSearchCursor,
  type SearchCursorScope,
} from "../src/message-reference.js";

const scope: SearchCursorScope = {
  accountId: "qq",
  folderId: "INBOX",
  from: "sender@example.com",
  subject: "hello",
};

describe("opaque IMAP references", () => {
  it("round-trips account/folder/UIDVALIDITY/UID without sequence numbers", () => {
    const encoded = encodeMessageReference({
      accountId: "qq",
      folderId: "INBOX",
      uidValidity: "123456789",
      uid: 42,
    });
    expect(encoded).not.toContain("INBOX");
    expect(decodeMessageReference(encoded)).toEqual({
      accountId: "qq",
      folderId: "INBOX",
      uidValidity: "123456789",
      uid: 42,
    });
  });

  it("rejects malformed message references", () => {
    expect(() => decodeMessageReference("not-a-reference")).toThrowError(
      expect.objectContaining({ code: "MESSAGE_REFERENCE_STALE" }),
    );
  });

  it("scopes pagination cursors to the exact search query", () => {
    const cursor = encodeSearchCursor(scope, 100);
    expect(decodeSearchCursor(cursor, scope)).toEqual({ lastUid: 100 });
    expect(() =>
      decodeSearchCursor(cursor, { ...scope, subject: "different" }),
    ).toThrowError(expect.objectContaining({ code: "CURSOR_INVALID" }));
  });
});
