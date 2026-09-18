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

import { describe, expect, it } from "vitest";
import { parseEmailAccountsConfig } from "../src/config.js";
import {
  buildEmailServer,
  listFolderMetadata,
  type EmailProviderFactory,
} from "../src/server.js";

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

describe("email_folders tracer", () => {
  it("uses the default account and passes count intent through the provider contract", async () => {
    const calls: unknown[] = [];
    const factory: EmailProviderFactory = (account) => ({
      async listFolders(options) {
        calls.push({ account: account.id, options });
        return [
          {
            id: "INBOX",
            name: "INBOX",
            special_use: "inbox",
            selectable: true,
            delimiter: "/",
            ...(options.includeCounts ? { total: 7, unread: 2 } : {}),
          },
        ];
      },
    });

    await expect(
      listFolderMetadata(catalog, factory, undefined, true),
    ).resolves.toEqual({
      account_id: "qq",
      folders: [
        {
          id: "INBOX",
          name: "INBOX",
          special_use: "inbox",
          selectable: true,
          delimiter: "/",
          total: 7,
          unread: 2,
        },
      ],
    });
    expect(calls).toEqual([
      { account: "qq", options: { includeCounts: true } },
    ]);

    expect(buildEmailServer(catalog, { allowModify: false, allowSend: false }, factory))
      .toBeDefined();
  });

  it("rejects an unknown account before creating a provider", async () => {
    let created = false;
    const factory: EmailProviderFactory = () => {
      created = true;
      return { async listFolders() { return []; } };
    };

    await expect(
      listFolderMetadata(catalog, factory, "missing", false),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    expect(created).toBe(false);
  });
});
