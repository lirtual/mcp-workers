import { describe, expect, it } from "vitest";
import { parseEmailAccountsConfig } from "../src/config.js";
import {
  buildSmtpTransportOptions,
  normalizeSmtpSendError,
  normalizeSmtpSendResult,
} from "../src/imap-smtp-provider.js";

describe("SMTP provider mapping", () => {
  it("maps implicit TLS and STARTTLS without caller-selected endpoints", () => {
    const qq = parseEmailAccountsConfig(JSON.stringify({
      default_account: "qq",
      accounts: {
        qq: {
          provider: "qq",
          address: "user@qq.com",
          auth: { type: "password", password: "secret" },
        },
      },
    })).accounts[0];

    expect(buildSmtpTransportOptions(qq)).toEqual({
      host: "smtp.qq.com",
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: "user@qq.com", pass: "secret" },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 15_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });

    const icloud = parseEmailAccountsConfig(JSON.stringify({
      default_account: "icloud",
      accounts: {
        icloud: {
          provider: "icloud",
          address: "user@icloud.com",
          auth: { type: "password", password: "secret" },
        },
      },
    })).accounts[0];

    expect(buildSmtpTransportOptions(icloud)).toMatchObject({
      host: "smtp.mail.me.com",
      port: 587,
      secure: false,
      requireTLS: true,
    });
  });

  it("normalizes partial acceptance without retry", () => {
    expect(
      normalizeSmtpSendResult({
        messageId: "<id@example.com>",
        accepted: ["ok@example.com"],
        rejected: ["bad@example.com"],
      }),
    ).toEqual({
      message_id: "<id@example.com>",
      accepted: ["ok@example.com"],
      rejected: ["bad@example.com"],
      partial: true,
    });
  });

  it("distinguishes proven pre-send auth rejection from ambiguous send failure", () => {
    expect(
      normalizeSmtpSendError(
        Object.assign(new Error("secret auth detail"), {
          code: "EAUTH",
          command: "AUTH PLAIN",
        }),
        false,
      ),
    ).toMatchObject({ code: "AUTH_FAILED" });

    expect(
      normalizeSmtpSendError(new Error("connection lost"), true),
    ).toMatchObject({ code: "SEND_OUTCOME_UNKNOWN" });
  });
});
