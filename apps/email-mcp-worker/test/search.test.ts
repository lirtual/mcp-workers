import { describe, expect, it } from "vitest";
import type { SearchObject } from "imapflow";
import { parseEmailAccountsConfig } from "../src/config.js";
import {
  buildSearchCriteria,
  searchEmail,
} from "../src/server.js";
import type { EmailProviderFactory } from "../src/provider.js";

describe("IMAP search criteria", () => {
  it("ANDs supported filters using provider-native criteria", () => {
    expect(
      buildSearchCriteria({
        from: "a@example.com",
        to: "b@example.com",
        subject: "invoice",
        text: "quarterly",
        after: "2026-09-01T00:00:00Z",
        before: "2026-09-19T00:00:00Z",
        unread: true,
        flagged: false,
      }),
    ).toEqual<SearchObject>({
      from: "a@example.com",
      to: "b@example.com",
      subject: "invoice",
      body: "quarterly",
      since: new Date("2026-09-01T00:00:00Z"),
      before: new Date("2026-09-19T00:00:00Z"),
      seen: false,
      flagged: false,
    });
  });

  it("uses ALL when no filter is supplied", () => {
    expect(buildSearchCriteria({})).toEqual<SearchObject>({ all: true });
  });
});

describe("email_search tracer", () => {
  const catalog = parseEmailAccountsConfig(
    JSON.stringify({
      default_account: "qq",
      accounts: {
        qq: {
          provider: "qq",
          address: "user@qq.com",
          auth: { type: "password", password: "secret" },
        },
      },
    }),
  );

  it("uses default account/INBOX and preserves provider pagination", async () => {
    const calls: unknown[] = [];
    const factory: EmailProviderFactory = (account) => ({
      async listFolders() {
        return [];
      },
      async searchMessages(options) {
        calls.push({ account: account.id, options });
        return {
          messages: [
            {
              message_id: "opaque",
              folder_id: "INBOX",
              subject: "hello",
              from: [{ address: "a@example.com" }],
              to: [{ address: "user@qq.com" }],
              cc: [],
              date: "2026-09-18T01:00:00.000Z",
              unread: true,
              flagged: false,
              has_attachments: false,
              size_bytes: 123,
            },
          ],
          next_cursor: "cursor-2",
        };
      },
    });

    await expect(
      searchEmail(catalog, factory, {
        subject: "hello",
        limit: 20,
      }),
    ).resolves.toEqual({
      account_id: "qq",
      folder_id: "INBOX",
      messages: [expect.objectContaining({ message_id: "opaque" })],
      next_cursor: "cursor-2",
    });

    expect(calls).toEqual([
      {
        account: "qq",
        options: {
          folderId: "INBOX",
          filters: { subject: "hello" },
          limit: 20,
          cursor: undefined,
        },
      },
    ]);
  });
});
