import { describe, expect, it } from "vitest";
import { parseEmailAccountsConfig } from "../src/config.js";
import { EmailToolError } from "../src/errors.js";
import { modifyEmail } from "../src/server.js";
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

function reference(uid: number) {
  return encodeMessageReference({
    accountId: "qq",
    folderId: "INBOX",
    uidValidity: "123",
    uid,
  });
}

describe("email_modify tracer", () => {
  it("fails closed before provider creation when modify is disabled", async () => {
    let created = false;
    const factory: EmailProviderFactory = () => {
      created = true;
      throw new Error("should not create provider");
    };

    await expect(
      modifyEmail(
        catalog,
        { allowModify: false, allowSend: false },
        factory,
        {
          folder_id: "INBOX",
          message_ids: [reference(1)],
          action: "mark_read",
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailToolError>>({
        code: "MODIFY_DISABLED",
      }),
    );
    expect(created).toBe(false);
  });

  it("passes only the fixed mutation contract to the provider", async () => {
    const calls: unknown[] = [];
    const factory: EmailProviderFactory = () => ({
      async listFolders() { return []; },
      async searchMessages() { return { messages: [] }; },
      async getMessage() { throw new Error("not used"); },
      async modifyMessages(options) {
        calls.push(options);
        return {
          action: options.action,
          modified_count: options.messageIds.length,
          ...(options.targetFolderId
            ? { target_folder_id: options.targetFolderId }
            : {}),
        };
      },
    });

    await expect(
      modifyEmail(
        catalog,
        { allowModify: true, allowSend: false },
        factory,
        {
          folder_id: "INBOX",
          message_ids: [reference(1), reference(2)],
          action: "move",
          target_folder_id: "Archive",
        },
      ),
    ).resolves.toEqual({
      account_id: "qq",
      folder_id: "INBOX",
      action: "move",
      modified_count: 2,
      target_folder_id: "Archive",
    });

    expect(calls).toEqual([
      {
        folderId: "INBOX",
        messageIds: [reference(1), reference(2)],
        action: "move",
        targetFolderId: "Archive",
      },
    ]);
  });
});
