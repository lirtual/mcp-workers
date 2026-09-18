import { describe, expect, it } from "vitest";
import {
  featureEnabled,
  parseEmailAccountsConfig,
  publicAccounts,
} from "../src/config.js";

function catalog(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    default_account: "qq",
    accounts: {
      qq: {
        provider: "qq",
        display_name: "Personal QQ",
        address: "user@qq.com",
        auth: {
          type: "password",
          username: "user@qq.com",
          password: "secret-auth-code",
        },
        ...overrides,
      },
    },
  });
}

describe("email account configuration", () => {
  it("resolves presets, default account, and read-only gates", () => {
    const parsed = parseEmailAccountsConfig(catalog());
    expect(parsed.defaultAccount).toBe("qq");
    expect(parsed.accounts[0]).toMatchObject({
      id: "qq",
      provider: "qq",
      address: "user@qq.com",
      displayName: "Personal QQ",
      enabled: true,
      imap: { host: "imap.qq.com", port: 993, tls: "implicit" },
      smtp: { host: "smtp.qq.com", port: 465, tls: "implicit" },
    });
    expect(featureEnabled(undefined)).toBe(false);
    expect(featureEnabled("TRUE")).toBe(false);
    expect(featureEnabled("true")).toBe(true);
  });

  it("rejects a disabled default account and plaintext transport", () => {
    expect(() => parseEmailAccountsConfig(catalog({ enabled: false }))).toThrow();
    expect(() =>
      parseEmailAccountsConfig(
        JSON.stringify({
          default_account: "custom",
          accounts: {
            custom: {
              provider: "custom",
              address: "user@example.com",
              auth: { type: "password", password: "secret" },
              imap: { host: "mail.example.com", port: 143, tls: "plaintext" },
              smtp: { host: "mail.example.com", port: 25, tls: "plaintext" },
            },
          },
        }),
      ),
    ).toThrow();
  });

  it("requires explicit encrypted endpoints for custom accounts", () => {
    expect(() =>
      parseEmailAccountsConfig(
        JSON.stringify({
          default_account: "custom",
          accounts: {
            custom: {
              provider: "custom",
              address: "user@example.com",
              auth: { type: "password", password: "secret" },
            },
          },
        }),
      ),
    ).toThrow();
  });

  it("never exposes credentials or endpoints through account discovery", () => {
    const parsed = parseEmailAccountsConfig(catalog());
    const result = publicAccounts(parsed, {
      allowModify: false,
      allowSend: false,
    });
    expect(result).toEqual([
      {
        id: "qq",
        display_name: "Personal QQ",
        address: "user@qq.com",
        provider: "qq",
        default: true,
        read_enabled: true,
        modify_enabled: false,
        send_enabled: false,
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-auth-code");
    expect(serialized).not.toContain("imap.qq.com");
    expect(serialized).not.toContain("smtp.qq.com");
  });
});
