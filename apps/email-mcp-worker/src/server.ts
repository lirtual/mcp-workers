import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  publicAccounts,
  resolveAccount,
  type EmailCatalog,
  type EmailFeatureGates,
} from "./config.js";
import { createImapSmtpProvider } from "./imap-smtp-provider.js";
import type {
  EmailProviderFactory,
  EmailFolder,
} from "./provider.js";

export type { EmailProviderFactory } from "./provider.js";

const accountOutputSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  address: z.string(),
  provider: z.enum(["qq", "gmail", "icloud", "fastmail", "custom"]),
  default: z.boolean(),
  read_enabled: z.boolean(),
  modify_enabled: z.boolean(),
  send_enabled: z.boolean(),
});

const folderOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  special_use: z.string().optional(),
  selectable: z.boolean(),
  delimiter: z.string().optional(),
  total: z.number().int().nonnegative().optional(),
  unread: z.number().int().nonnegative().optional(),
});

function toolSuccess<T extends object>(data: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: "Email result returned in structuredContent.",
      },
    ],
    structuredContent: data,
  };
}

export function listAccountMetadata(
  catalog: EmailCatalog,
  gates: EmailFeatureGates,
) {
  return { accounts: publicAccounts(catalog, gates) };
}

export async function listFolderMetadata(
  catalog: EmailCatalog,
  providerFactory: EmailProviderFactory,
  accountId: string | undefined,
  includeCounts: boolean,
): Promise<{ account_id: string; folders: EmailFolder[] }> {
  const account = resolveAccount(catalog, accountId);
  const provider = providerFactory(account);
  return {
    account_id: account.id,
    folders: await provider.listFolders({ includeCounts }),
  };
}

export function buildEmailServer(
  catalog: EmailCatalog,
  gates: EmailFeatureGates,
  providerFactory: EmailProviderFactory = createImapSmtpProvider,
): McpServer {
  const server = new McpServer({
    name: "email-mcp-worker",
    version: "0.1.0",
  });

  server.registerTool(
    "email_accounts",
    {
      description:
        "List configured email accounts and non-secret read/modify/send capability flags. Credentials and mail server endpoints are never returned.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({}),
      outputSchema: z.object({
        accounts: z.array(accountOutputSchema),
      }),
    },
    async () => toolSuccess(listAccountMetadata(catalog, gates)),
  );

  server.registerTool(
    "email_folders",
    {
      description:
        "List selectable mail folders and special-use metadata for one configured email account. Counts are returned only when explicitly requested.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        account_id: z.string().min(1).max(64).optional(),
        include_counts: z.boolean().default(false),
      }),
      outputSchema: z.object({
        account_id: z.string(),
        folders: z.array(folderOutputSchema),
      }),
    },
    async ({ account_id, include_counts }) =>
      toolSuccess(
        await listFolderMetadata(
          catalog,
          providerFactory,
          account_id,
          include_counts,
        ),
      ),
  );

  return server;
}
