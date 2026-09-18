import { describe, expect, it } from "vitest";
import { parseEmailAccountsConfig } from "../src/config.js";
import { EmailToolError } from "../src/errors.js";
import {
  prepareSendEmail,
  sendEmail,
  type SendEmailInput,
} from "../src/server.js";
import type {
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

function factory(calls: SendMessageOptions[]): EmailProviderFactory {
  return (): EmailProvider => ({
    async listFolders() { return []; },
    async searchMessages() { return { messages: [] }; },
    async getMessage() { throw new Error("not used"); },
    async modifyMessages() { throw new Error("not used"); },
    async sendMessage(options) {
      calls.push(options);
      return {
        message_id: "<test@example.com>",
        accepted: options.to.map((value) => value.address),
        rejected: [],
        partial: false,
      };
    },
  });
}

const baseInput: SendEmailInput = {
  to: ["recipient@example.com"],
  subject: "Hello",
  body_text: "Exact body",
};

describe("email_send preparation", () => {
  it("fails closed before provider creation when sending is disabled", async () => {
    let created = false;
    const providerFactory: EmailProviderFactory = () => {
      created = true;
      throw new Error("provider must not be created");
    };

    await expect(
      sendEmail(
        catalog,
        { allowModify: false, allowSend: false },
        providerFactory,
        baseInput,
      ),
    ).rejects.toMatchObject({ code: "SEND_DISABLED" });
    expect(created).toBe(false);
  });

  it("uses the canonical sender by default and enforces the configured allowlist", () => {
    expect(
      prepareSendEmail(catalog, { ...baseInput, from: undefined }),
    ).toMatchObject({
      account_id: "qq",
      from: "user@qq.com",
      to: [{ address: "recipient@example.com" }],
      subject: "Hello",
      body_text: "Exact body",
    });

    expect(() =>
      prepareSendEmail(catalog, {
        ...baseInput,
        from: "attacker@example.com",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EmailToolError>>({
        code: "SENDER_NOT_ALLOWED",
      }),
    );
  });

  it("enforces total recipient and UTF-8 body bounds before SMTP", () => {
    expect(() =>
      prepareSendEmail(catalog, {
        ...baseInput,
        to: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EmailToolError>>({
        code: "RECIPIENT_LIMIT_EXCEEDED",
      }),
    );

    expect(() =>
      prepareSendEmail(catalog, {
        ...baseInput,
        body_text: "界".repeat(50_000),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EmailToolError>>({
        code: "MESSAGE_TOO_LARGE",
      }),
    );
  });

  it("passes only bounded plain-text compose data to the provider", async () => {
    const calls: SendMessageOptions[] = [];
    await expect(
      sendEmail(
        catalog,
        { allowModify: false, allowSend: true },
        factory(calls),
        {
          ...baseInput,
          from: "alias@example.com",
          cc: ["cc@example.com"],
          bcc: ["bcc@example.com"],
        },
      ),
    ).resolves.toEqual({
      account_id: "qq",
      message_id: "<test@example.com>",
      accepted: ["recipient@example.com"],
      rejected: [],
      partial: false,
    });

    expect(calls).toEqual([
      {
        from: "alias@example.com",
        to: [{ address: "recipient@example.com" }],
        cc: [{ address: "cc@example.com" }],
        bcc: [{ address: "bcc@example.com" }],
        subject: "Hello",
        bodyText: "Exact body",
      },
    ]);
  });
});
