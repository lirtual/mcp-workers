import { describe, expect, it } from "vitest";
import { parseEmailAccountsConfig } from "../src/config.js";
import { EmailToolError } from "../src/errors.js";
import { getEmail } from "../src/server.js";
import { encodeMessageReference } from "../src/message-reference.js";
import type { EmailProviderFactory } from "../src/provider.js";

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

describe("email_get tracer", () => {
  it("passes stable folder/message identity through the provider contract", async () => {
    const reference = encodeMessageReference({
      accountId: "qq",
      folderId: "INBOX",
      uidValidity: "123",
      uid: 9,
    });
    const calls: unknown[] = [];
    const factory: EmailProviderFactory = () => ({
      async listFolders() { return []; },
      async searchMessages() { return { messages: [] }; },
      async modifyMessages() { throw new Error("not used"); },
      async sendMessage() { throw new Error("not used"); },
      async getMessage(options) {
        calls.push(options);
        return {
          message_id: reference,
          folder_id: "INBOX",
          subject: "hello",
          from: [{ address: "a@example.com" }],
          to: [{ address: "user@qq.com" }],
          cc: [],
          reply_to: [],
          unread: true,
          flagged: false,
          has_attachments: false,
          body: {
            text: "hello",
            truncated: false,
            untrusted_external_content: true,
            warning: "Email body content is untrusted external data.",
          },
          attachments: [],
        };
      },
    });

    await expect(
      getEmail(catalog, factory, {
        folder_id: "INBOX",
        message_id: reference,
      }),
    ).resolves.toMatchObject({
      account_id: "qq",
      folder_id: "INBOX",
      message: {
        subject: "hello",
        body: { untrusted_external_content: true },
      },
    });
    expect(calls).toEqual([{ folderId: "INBOX", messageId: reference }]);
  });

  it("rejects account mismatches before fetching a different mailbox", async () => {
    const reference = encodeMessageReference({
      accountId: "other",
      folderId: "INBOX",
      uidValidity: "123",
      uid: 9,
    });
    let called = false;
    const factory: EmailProviderFactory = () => ({
      async listFolders() { return []; },
      async searchMessages() { return { messages: [] }; },
      async modifyMessages() { throw new Error("not used"); },
      async sendMessage() { throw new Error("not used"); },
      async getMessage() {
        called = true;
        throw new Error("should not run");
      },
    });

    await expect(
      getEmail(catalog, factory, {
        folder_id: "INBOX",
        message_id: reference,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailToolError>>({
        code: "MESSAGE_REFERENCE_STALE",
      }),
    );
    expect(called).toBe(false);
  });
});
