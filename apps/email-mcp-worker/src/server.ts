import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  publicAccounts,
  resolveAccount,
  type EmailCatalog,
  type EmailFeatureGates,
} from "./config.js";
import {
  buildSearchCriteria,
  createImapSmtpProvider,
} from "./imap-smtp-provider.js";
import type {
  EmailProviderFactory,
  EmailFolder,
  EmailSearchFilters,
  SearchMessagesResult,
} from "./provider.js";

export type { EmailProviderFactory } from "./provider.js";
export { buildSearchCriteria };

const accountIdSchema = z.string().min(1).max(64);
const folderIdSchema = z.string().min(1).max(1024);
const searchTextSchema = z.string().min(1).max(1000);
const isoDateTimeSchema = z.string().datetime({ offset: true });

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

const addressOutputSchema = z.object({
  name: z.string().optional(),
  address: z.string(),
});

const searchMessageOutputSchema = z.object({
  message_id: z.string(),
  folder_id: z.string(),
  subject: z.string().optional(),
  from: z.array(addressOutputSchema),
  to: z.array(addressOutputSchema),
  cc: z.array(addressOutputSchema),
  date: z.string().optional(),
  unread: z.boolean(),
  flagged: z.boolean(),
  has_attachments: z.boolean(),
  size_bytes: z.number().int().nonnegative().optional(),
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

export interface SearchEmailInput extends EmailSearchFilters {
  account_id?: string;
  folder_id?: string;
  cursor?: string;
  limit?: number;
}

export async function searchEmail(
  catalog: EmailCatalog,
  providerFactory: EmailProviderFactory,
  input: SearchEmailInput,
): Promise<
  SearchMessagesResult & { account_id: string; folder_id: string }
> {
  const account = resolveAccount(catalog, input.account_id);
  const folderId = input.folder_id ?? "INBOX";
  const {
    account_id: _accountId,
    folder_id: _folderId,
    cursor,
    limit = 20,
    ...filters
  } = input;
  void _accountId;
  void _folderId;
  const provider = providerFactory(account);
  return {
    account_id: account.id,
    folder_id: folderId,
    ...(await provider.searchMessages({
      folderId,
      filters,
      limit,
      cursor,
    })),
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
        account_id: accountIdSchema.optional(),
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

  server.registerTool(
    "email_search",
    {
      description:
        "Search one configured mailbox with structured provider-side filters. Returns bounded envelope metadata only; message bodies and attachment bytes are never returned.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        account_id: accountIdSchema.optional(),
        folder_id: folderIdSchema.optional(),
        from: searchTextSchema.optional(),
        to: searchTextSchema.optional(),
        subject: searchTextSchema.optional(),
        text: searchTextSchema.optional(),
        after: isoDateTimeSchema.optional(),
        before: isoDateTimeSchema.optional(),
        unread: z.boolean().optional(),
        flagged: z.boolean().optional(),
        cursor: z.string().min(1).max(8192).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: z.object({
        account_id: z.string(),
        folder_id: z.string(),
        messages: z.array(searchMessageOutputSchema).max(50),
        next_cursor: z.string().optional(),
      }),
    },
    async (input) => toolSuccess(await searchEmail(catalog, providerFactory, input)),
  );

  return server;
}
