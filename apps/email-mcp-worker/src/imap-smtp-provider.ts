import {
  ImapFlow,
  type ListResponse,
  type MessageAddressObject,
  type MessageEnvelopeObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import type { ResolvedEmailAccount } from "./config.js";
import { EmailToolError } from "./errors.js";
import {
  decodeSearchCursor,
  encodeMessageReference,
  encodeSearchCursor,
  type SearchCursorScope,
} from "./message-reference.js";
import type {
  EmailAddress,
  EmailFolder,
  EmailProvider,
  EmailSearchFilters,
  EmailSearchMessage,
  ListFoldersOptions,
  SearchMessagesOptions,
  SearchMessagesResult,
} from "./provider.js";

type FolderEntry = Pick<
  ListResponse,
  "path" | "name" | "delimiter" | "flags" | "specialUse" | "status"
>;

const SPECIAL_USE = new Map<string, string>([
  ["\\sent", "sent"],
  ["\\trash", "trash"],
  ["\\junk", "junk"],
  ["\\drafts", "drafts"],
  ["\\archive", "archive"],
  ["\\all", "all"],
  ["\\flagged", "flagged"],
]);

function specialUse(entry: FolderEntry): string | undefined {
  if (entry.path.toUpperCase() === "INBOX") return "inbox";
  if (!entry.specialUse) return undefined;
  return SPECIAL_USE.get(entry.specialUse.toLowerCase()) ??
    entry.specialUse.replace(/^\\+/, "").toLowerCase();
}

export function normalizeFolder(
  entry: FolderEntry,
  includeCounts: boolean,
): EmailFolder {
  const normalizedSpecialUse = specialUse(entry);
  return {
    id: entry.path,
    name: entry.name,
    ...(normalizedSpecialUse ? { special_use: normalizedSpecialUse } : {}),
    selectable: !entry.flags.has("\\Noselect"),
    ...(entry.delimiter ? { delimiter: entry.delimiter } : {}),
    ...(includeCounts && entry.status?.messages != null
      ? { total: entry.status.messages }
      : {}),
    ...(includeCounts && entry.status?.unseen != null
      ? { unread: entry.status.unseen }
      : {}),
  };
}

export function buildSearchCriteria(filters: EmailSearchFilters): SearchObject {
  const criteria: SearchObject = {};
  if (filters.from) criteria.from = filters.from;
  if (filters.to) criteria.to = filters.to;
  if (filters.subject) criteria.subject = filters.subject;
  if (filters.text) criteria.body = filters.text;
  if (filters.after) criteria.since = new Date(filters.after);
  if (filters.before) criteria.before = new Date(filters.before);
  if (filters.unread !== undefined) criteria.seen = !filters.unread;
  if (filters.flagged !== undefined) criteria.flagged = filters.flagged;
  return Object.keys(criteria).length === 0 ? { all: true } : criteria;
}

function normalizeAddresses(
  values: MessageAddressObject[] | undefined,
): EmailAddress[] {
  if (!values) return [];
  return values.flatMap((value) =>
    value.address
      ? [{
          ...(value.name ? { name: value.name } : {}),
          address: value.address,
        }]
      : [],
  );
}

function structureHasAttachment(
  node: MessageStructureObject | undefined,
): boolean {
  if (!node) return false;
  const disposition = node.disposition?.toLowerCase();
  if (
    disposition === "attachment" ||
    typeof node.dispositionParameters?.filename === "string" ||
    typeof node.parameters?.name === "string"
  ) {
    return true;
  }
  return node.childNodes?.some(structureHasAttachment) ?? false;
}

function normalizeSearchMessage(
  accountId: string,
  folderId: string,
  uidValidity: bigint,
  message: {
    uid: number;
    envelope?: MessageEnvelopeObject;
    flags?: Set<string>;
    size?: number;
    bodyStructure?: MessageStructureObject;
  },
): EmailSearchMessage {
  const envelope = message.envelope;
  const flags = message.flags ?? new Set<string>();
  const date = envelope?.date ? new Date(envelope.date).toISOString() : undefined;
  return {
    message_id: encodeMessageReference({
      accountId,
      folderId,
      uidValidity: String(uidValidity),
      uid: message.uid,
    }),
    folder_id: folderId,
    ...(envelope?.subject ? { subject: envelope.subject } : {}),
    from: normalizeAddresses(envelope?.from),
    to: normalizeAddresses(envelope?.to),
    cc: normalizeAddresses(envelope?.cc),
    ...(date ? { date } : {}),
    unread: !flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    has_attachments: structureHasAttachment(message.bodyStructure),
    ...(message.size != null ? { size_bytes: message.size } : {}),
  };
}

function cursorScope(
  accountId: string,
  options: SearchMessagesOptions,
): SearchCursorScope {
  return {
    accountId,
    folderId: options.folderId,
    ...options.filters,
  };
}

export function normalizeImapError(error: unknown): EmailToolError {
  if (error instanceof EmailToolError) return error;
  const details =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          responseStatus?: unknown;
          responseCode?: unknown;
          authenticationFailed?: unknown;
        })
      : {};
  const code = typeof details.code === "string" ? details.code.toUpperCase() : "";
  const responseStatus =
    typeof details.responseStatus === "string"
      ? details.responseStatus.toUpperCase()
      : "";
  const responseCode =
    typeof details.responseCode === "string"
      ? details.responseCode.toUpperCase()
      : "";

  if (
    code === "EAUTH" ||
    details.authenticationFailed === true ||
    responseStatus === "AUTHENTICATIONFAILED"
  ) {
    return new EmailToolError(
      "AUTH_FAILED",
      "Email provider authentication failed.",
    );
  }

  if (
    code === "ETIMEDOUT" ||
    code === "ETIMEOUT" ||
    code === "ESOCKETTIMEDOUT"
  ) {
    return new EmailToolError(
      "UPSTREAM_TIMEOUT",
      "Email provider request timed out.",
    );
  }

  if (
    code === "MAILBOX_NOT_FOUND" ||
    responseCode === "NONEXISTENT"
  ) {
    return new EmailToolError(
      "FOLDER_NOT_FOUND",
      "The requested email folder was not found.",
    );
  }

  return new EmailToolError(
    "UPSTREAM_UNAVAILABLE",
    "Email provider is unavailable.",
  );
}

export class ImapSmtpProvider implements EmailProvider {
  constructor(private readonly account: ResolvedEmailAccount) {}

  private createImapClient(): ImapFlow {
    return new ImapFlow({
      host: this.account.imap.host,
      port: this.account.imap.port,
      secure: true,
      auth: {
        user: this.account.auth.username,
        pass: this.account.auth.password,
      },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 15_000,
      clientInfo: { name: "email-mcp-worker" },
    });
  }

  private async withImap<T>(run: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.createImapClient();
    let connected = false;
    try {
      await client.connect();
      connected = true;
      return await run(client);
    } catch (error) {
      throw normalizeImapError(error);
    } finally {
      if (connected) {
        try {
          await client.logout();
        } catch {
          client.close();
        }
      } else {
        client.close();
      }
    }
  }

  async listFolders(options: ListFoldersOptions): Promise<EmailFolder[]> {
    return this.withImap(async (client) => {
      const folders = await client.list(
        options.includeCounts
          ? { statusQuery: { messages: true, unseen: true } }
          : undefined,
      );
      return folders.map((folder) =>
        normalizeFolder(folder, options.includeCounts),
      );
    });
  }

  async searchMessages(
    options: SearchMessagesOptions,
  ): Promise<SearchMessagesResult> {
    return this.withImap(async (client) => {
      const mailbox = await client.mailboxOpen(options.folderId, {
        readOnly: true,
      });
      const scope = cursorScope(this.account.id, options);
      const cursor = options.cursor
        ? decodeSearchCursor(options.cursor, scope)
        : undefined;

      const result = await client.search(
        buildSearchCriteria(options.filters),
        { uid: true },
      );
      const matched = Array.isArray(result) ? result : [];
      const ordered = matched
        .filter((uid) => cursor === undefined || uid < cursor.lastUid)
        .sort((left, right) => right - left);
      const pageUids = ordered.slice(0, options.limit);
      const hasMore = ordered.length > options.limit;
      const messages: EmailSearchMessage[] = [];

      if (pageUids.length > 0) {
        for await (const message of client.fetch(
          pageUids,
          {
            uid: true,
            envelope: true,
            flags: true,
            size: true,
            bodyStructure: true,
          },
          { uid: true },
        )) {
          messages.push(
            normalizeSearchMessage(
              this.account.id,
              options.folderId,
              mailbox.uidValidity,
              message,
            ),
          );
        }
        const rank = new Map(pageUids.map((uid, index) => [uid, index]));
        messages.sort((left, right) => {
          const leftRef = left.message_id;
          const rightRef = right.message_id;
          const leftUid = pageUids.find((uid) =>
            leftRef === encodeMessageReference({
              accountId: this.account.id,
              folderId: options.folderId,
              uidValidity: String(mailbox.uidValidity),
              uid,
            }),
          );
          const rightUid = pageUids.find((uid) =>
            rightRef === encodeMessageReference({
              accountId: this.account.id,
              folderId: options.folderId,
              uidValidity: String(mailbox.uidValidity),
              uid,
            }),
          );
          return (rank.get(leftUid ?? 0) ?? 0) - (rank.get(rightUid ?? 0) ?? 0);
        });
      }

      const lastUid = pageUids.at(-1);
      return {
        messages,
        ...(hasMore && lastUid
          ? { next_cursor: encodeSearchCursor(scope, lastUid) }
          : {}),
      };
    });
  }
}

export function createImapSmtpProvider(
  account: ResolvedEmailAccount,
): EmailProvider {
  return new ImapSmtpProvider(account);
}
