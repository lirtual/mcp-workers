import { describe, expect, it } from "vitest";
import { parseEmailAccountsConfig } from "../src/config.js";
import { listAccountMetadata } from "../src/server.js";

describe("email_accounts tool projection", () => {
  it("uses the configured default and exposes only non-secret capability metadata", () => {
    const parsed = parseEmailAccountsConfig(
      JSON.stringify({
        default_account: "personal",
        accounts: {
          personal: {
            provider: "icloud",
            address: "me@icloud.com",
            auth: { type: "password", password: "app-password" },
          },
          disabled: {
            provider: "gmail",
            address: "disabled@example.com",
            enabled: false,
            auth: { type: "password", password: "other-secret" },
          },
        },
      }),
    );

    expect(
      listAccountMetadata(parsed, {
        allowModify: true,
        allowSend: false,
      }),
    ).toEqual({
      accounts: [
        {
          id: "personal",
          display_name: "personal",
          address: "me@icloud.com",
          provider: "icloud",
          default: true,
          read_enabled: true,
          modify_enabled: true,
          send_enabled: false,
        },
      ],
    });
  });
});
