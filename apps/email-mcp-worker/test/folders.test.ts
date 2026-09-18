import { describe, expect, it } from "vitest";
import {
  normalizeFolder,
  normalizeImapError,
} from "../src/imap-smtp-provider.js";

describe("IMAP folder normalization", () => {
  it("normalizes special-use and optional counts without exposing protocol details", () => {
    const folder = normalizeFolder(
      {
        path: "Deleted Messages",
        name: "Deleted Messages",
        delimiter: "/",
        flags: new Set(["\\HasNoChildren"]),
        specialUse: "\\Trash",
        status: { messages: 12, unseen: 3 },
      },
      true,
    );

    expect(folder).toEqual({
      id: "Deleted Messages",
      name: "Deleted Messages",
      special_use: "trash",
      selectable: true,
      delimiter: "/",
      total: 12,
      unread: 3,
    });
  });

  it("omits counts when they were not requested and marks noselect folders", () => {
    const folder = normalizeFolder(
      {
        path: "Container",
        name: "Container",
        delimiter: "/",
        flags: new Set(["\\Noselect"]),
      },
      false,
    );

    expect(folder).toEqual({
      id: "Container",
      name: "Container",
      selectable: false,
      delimiter: "/",
    });
  });

  it("normalizes INBOX special use even when the server omits SPECIAL-USE", () => {
    expect(
      normalizeFolder(
        {
          path: "INBOX",
          name: "INBOX",
          delimiter: "/",
          flags: new Set(),
        },
        false,
      ).special_use,
    ).toBe("inbox");
  });
});

describe("IMAP errors", () => {
  it("maps authentication failures without leaking the upstream message", () => {
    const error = normalizeImapError(
      Object.assign(new Error("LOGIN failed for secret user"), { code: "EAUTH" }),
    );
    expect(error.code).toBe("AUTH_FAILED");
    expect(error.message).not.toContain("secret");
  });

  it("maps timeout and generic upstream failures to stable safe errors", () => {
    expect(
      normalizeImapError(Object.assign(new Error("socket"), { code: "ETIMEDOUT" })).code,
    ).toBe("UPSTREAM_TIMEOUT");
    expect(normalizeImapError(new Error("private upstream detail")).code).toBe(
      "UPSTREAM_UNAVAILABLE",
    );
  });
});
