import { describe, expect, it } from "vitest";
import { parseEmailAccountsConfig } from "../src/config.js";
import {
  prepareRespondEmail,
  respondEmail,
  type RespondEmailInput,
} from "../src/server.js";
import { encodeMessageReference } from "../src/message-reference.js";
import type {
  EmailMessageDetail,
  EmailProvider,
  EmailProviderFactory,
  SendMessageOptions,
} from "../src/provider.js";

const catalog = parseEmailAccountsConfig(
  JSON.stringify({
    default_account: "qq",
    accounts: {
      qq: {
        provider: "qq",
        address: "user@qq.com",
        senders: ["user@qq.com", "alias@example.com"],
        auth: { type: "password", password: "secret" },
      },
    },
  }),
);

const messageId = encodeMessageReference({
  accountId: "qq",
  folderId: "INBOX",
  uidValidity: "123",
  uid: 9,
});

function original(overrides: Partial<EmailMessageDetail> = {}): EmailMessageDetail {
  return {
    message_id: messageId,
    folder_id: "INBOX",
    subject: "Status",
    from: [{ address: "sender@example.com" }],
    to: [
      { address: "user@qq.com" },
      { address: "other@example.com" },
    ],
    cc: [
      { address: "ALIAS@example.com" },
      { address: "team@example.com" },
      { address: "other@example.com" },
    ],
    reply_to: [{ address: "support@example.com" }],
    unread: true,
    flagged: false,
    has_attachments: true,
    internet_message_id: "<msg@example.com>",
    references: "<root@example.com>",
    body: {
      text: "Original body",
      truncated: false,
      untrusted_external_content: true,
      warning: "untrusted",
    },
    attachments: [
      { filename: "report.pdf", media_type: "application/pdf" },
    ],
    ...overrides,
  };
}

function factory(
  source: EmailMessageDetail,
  sent: SendMessageOptions[] = [],
): EmailProviderFactory {
  return (): EmailProvider => ({
    async listFolders() { return []; },
    async searchMessages() { return { messages: [] }; },
    async modifyMessages() { throw new Error("not used"); },
    async getMessage() { return source; },
    async sendMessage(options) {
      sent.push(options);
      return {
        message_id: "<sent@example.com>",
        accepted: options.to.map((entry) => entry.address),
        rejected: [],
        partial: false,
      };
    },
  });
}

function base(mode: "reply" | "reply_all" = "reply"): RespondEmailInput {
  return {
    mode,
    folder_id: "INBOX",
    message_id: messageId,
    body_text: "My response",
  };
}

describe("email_respond preparation", () => {
  it("uses Reply-To, preserves threading, and avoids duplicate Re prefixes", async () => {
    const prepared = await prepareRespondEmail(
      catalog,
      factory(original({ subject: "Re: Status" })),
      base("reply"),
    );
    expect(prepared).toMatchObject({
      mode: "reply",
      from: "user@qq.com",
      to: [{ address: "support@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Status",
      in_reply_to: "<msg@example.com>",
      references: "<root@example.com> <msg@example.com>",
      attachments_omitted: true,
    });
    expect(prepared.body_text).toContain("My response");
    expect(prepared.body_text).toContain("Original body");
  });

  it("falls back to From when Reply-To is absent", async () => {
    const prepared = await prepareRespondEmail(
      catalog,
      factory(original({ reply_to: [] })),
      base("reply"),
    );
    expect(prepared.to).toEqual([{ address: "sender@example.com" }]);
  });

  it("reply-all removes self identities and de-duplicates recipients case-insensitively", async () => {
    const prepared = await prepareRespondEmail(
      catalog,
      factory(original()),
      base("reply_all"),
    );
    expect(prepared.to).toEqual([{ address: "support@example.com" }]);
    expect(prepared.cc).toEqual([
      { address: "other@example.com" },
      { address: "team@example.com" },
    ]);
  });

  it("forward requires explicit recipients, uses one Fwd prefix, and reports attachment omission", async () => {
    const input: RespondEmailInput = {
      mode: "forward",
      folder_id: "INBOX",
      message_id: messageId,
      body_text: "FYI",
      to: ["new@example.com"],
    };
    const prepared = await prepareRespondEmail(
      catalog,
      factory(original({ subject: "Fwd: Status" })),
      input,
    );
    expect(prepared).toMatchObject({
      mode: "forward",
      to: [{ address: "new@example.com" }],
      subject: "Fwd: Status",
      attachments_omitted: true,
    });
    expect(prepared.in_reply_to).toBeUndefined();
    expect(prepared.references).toBeUndefined();
  });

  it("bounds quoted original content to the compose byte limit", async () => {
    const prepared = await prepareRespondEmail(
      catalog,
      factory(original({
        body: {
          text: "界".repeat(100_000),
          truncated: true,
          untrusted_external_content: true,
          warning: "untrusted",
        },
      })),
      base("reply"),
    );
    expect(new TextEncoder().encode(prepared.body_text).byteLength)
      .toBeLessThanOrEqual(128 * 1024);
  });
});

describe("email_respond send behavior", () => {
  it("fails closed before reading the source when send is disabled", async () => {
    let created = false;
    const providerFactory: EmailProviderFactory = () => {
      created = true;
      throw new Error("must not create provider");
    };
    await expect(
      respondEmail(
        catalog,
        { allowModify: false, allowSend: false },
        providerFactory,
        base("reply"),
      ),
    ).rejects.toMatchObject({ code: "SEND_DISABLED" });
    expect(created).toBe(false);
  });

  it("sends the prepared threading metadata through the provider contract", async () => {
    const sent: SendMessageOptions[] = [];
    await expect(
      respondEmail(
        catalog,
        { allowModify: false, allowSend: true },
        factory(original(), sent),
        base("reply"),
      ),
    ).resolves.toMatchObject({
      account_id: "qq",
      mode: "reply",
      message_id: "<sent@example.com>",
      partial: false,
    });
    expect(sent[0]).toMatchObject({
      to: [{ address: "support@example.com" }],
      subject: "Re: Status",
      inReplyTo: "<msg@example.com>",
      references: "<root@example.com> <msg@example.com>",
    });
  });
});
