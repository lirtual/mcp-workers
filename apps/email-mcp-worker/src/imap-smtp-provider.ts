import nodemailer from "nodemailer";
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
  decodeMessageReference,
  decodeSearchCursor,
  encodeMessageReference,
  encodeSearchCursor,
  type SearchCursorScope,
} from "./message-reference.js";
import {
  MAX_SOURCE_BYTES,
  normalizeMimeMessage,
  oversizedMessageFallback,
  type NormalizedMessagePayload,
  structureAttachmentMetadata,
  unavailableMessageBody,
} from "./message-normalizer.js";
import type {
  EmailAddress,
  EmailFolder,
  EmailMessageDetail,
  EmailProvider,
  EmailSearchFilters,
  EmailSearchMessage,
  GetMessageOptions,
  ListFoldersOptions,
  ModifyMessagesOptions,
  ModifyMessagesResult,
  SearchMessagesOptions,
  SearchMessagesResult,
  SendMessageOptions,
  SendMessageResult,
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


export interface ReadableBodyPart {
  part: string;
  mediaType: "text/plain" | "text/html";
  charset?: string;
  encoding?: string;
  size?: number;
}

function nodeIsAttachment(node: MessageStructureObject): boolean {
  const disposition = node.disposition?.toLowerCase();
  return (
    disposition === "attachment" ||
    typeof node.dispositionParameters?.filename === "string" ||
    typeof node.parameters?.name === "string"
  );
}

export function selectReadableBodyParts(
  root: MessageStructureObject | undefined,
  maxBytes = MAX_SOURCE_BYTES,
): ReadableBodyPart[] {
  if (!root) return [];

  const selected = new Map<"text/plain" | "text/html", ReadableBodyPart>();

  const visit = (
    node: MessageStructureObject,
    ancestorAttachment: boolean,
  ): void => {
    const attachment = ancestorAttachment || nodeIsAttachment(node);
    const mediaType = node.type?.toLowerCase();

    if (
      !attachment &&
      (mediaType === "text/plain" || mediaType === "text/html") &&
      node.part &&
      !selected.has(mediaType) &&
      (node.size == null || node.size <= maxBytes)
    ) {
      selected.set(mediaType, {
        part: node.part,
        mediaType,
        ...(node.parameters?.charset
          ? { charset: node.parameters.charset }
          : {}),
        ...(node.encoding ? { encoding: node.encoding } : {}),
        ...(node.size != null ? { size: node.size } : {}),
      });
    }

    for (const child of node.childNodes ?? []) {
      visit(child, attachment);
    }
  };

  visit(root, false);

  return ["text/plain", "text/html"].flatMap((mediaType) => {
    const part = selected.get(mediaType as "text/plain" | "text/html");
    return part ? [part] : [];
  });
}

function hasOversizedReadableBodyPart(
  root: MessageStructureObject | undefined,
  maxBytes = MAX_SOURCE_BYTES,
): boolean {
  if (!root) return false;
  const visit = (
    node: MessageStructureObject,
    ancestorAttachment: boolean,
  ): boolean => {
    const attachment = ancestorAttachment || nodeIsAttachment(node);
    const mediaType = node.type?.toLowerCase();
    if (
      !attachment &&
      (mediaType === "text/plain" || mediaType === "text/html") &&
      node.size != null &&
      node.size > maxBytes
    ) {
      return true;
    }
    return (node.childNodes ?? []).some((child) => visit(child, attachment));
  };
  return visit(root, false);
}

export async function normalizeFetchedBodyParts(
  parts: ReadableBodyPart[],
  bodyParts: Map<string, Uint8Array>,
): Promise<NormalizedMessagePayload> {
  let text: string | undefined;
  let html: string | undefined;
  let truncated = false;

  for (const part of parts) {
    const raw = bodyParts.get(part.part);
    if (!raw || raw.byteLength > MAX_SOURCE_BYTES) continue;

    const charset = part.charset
      ? '; charset="' + part.charset.replace(/"/g, "") + '"'
      : "";
    const transferEncoding = part.encoding
      ? "\r\nContent-Transfer-Encoding: " + part.encoding
      : "";
    const header = new TextEncoder().encode(
      "MIME-Version: 1.0\r\nContent-Type: " +
        part.mediaType +
        charset +
        transferEncoding +
        "\r\n\r\n",
    );
    const synthetic = new Uint8Array(header.byteLength + raw.byteLength);
    synthetic.set(header, 0);
    synthetic.set(raw, header.byteLength);

    const normalized = await normalizeMimeMessage(synthetic);
    truncated = truncated || normalized.body.truncated;

    if (part.mediaType === "text/plain" && normalized.body.text) {
      text = normalized.body.text;
    }
    if (part.mediaType === "text/html" && normalized.body.html) {
      html = normalized.body.html;
    }
  }

  if (!text && !html) {
    return {
      body: unavailableMessageBody("body_not_found"),
      attachments: [],
      reply_to: [],
    };
  }

  const warning = unavailableMessageBody("body_not_found").warning;
  return {
    body: {
      ...(text ? { text } : {}),
      ...(html ? { html } : {}),
      truncated,
      untrusted_external_content: true,
      warning,
    },
    attachments: [],
    reply_to: [],
  };
}

export function parseReferencesHeader(
  headers: Uint8Array | undefined,
): string | undefined {
  if (!headers) return undefined;
  const unfolded = new TextDecoder()
    .decode(headers)
    .replace(/\r?\n[\t ]+/g, " ");
  const match = unfolded.match(/^references:\s*(.+)$/im);
  const value = match?.[1]?.trim();
  return value || undefined;
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


export function validateMutationReferences(
  accountId: string,
  folderId: string,
  messageIds: string[],
  uidValidity: bigint,
): number[] {
  return messageIds.map((messageId) => {
    const reference = decodeMessageReference(messageId);
    if (
      reference.accountId !== accountId ||
      reference.folderId !== folderId ||
      reference.uidValidity !== String(uidValidity)
    ) {
      throw new EmailToolError(
        "MESSAGE_REFERENCE_STALE",
        "One or more message references are stale for the selected mailbox.",
      );
    }
    return reference.uid;
  });
}

function trashPath(folders: ListResponse[]): string | undefined {
  return folders.find(
    (folder) => folder.specialUse?.toLowerCase() === "\\trash",
  )?.path;
}


export function buildSmtpTransportOptions(account: ResolvedEmailAccount) {
  const implicit = account.smtp.tls === "implicit";
  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: implicit,
    requireTLS: !implicit,
    auth: {
      user: account.auth.username,
      pass: account.auth.password,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

function addressText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "address" in value) {
    const address = (value as { address?: unknown }).address;
    return typeof address === "string" ? address : String(address ?? "");
  }
  return String(value ?? "");
}

export function normalizeSmtpSendResult(info: {
  messageId?: string;
  accepted?: unknown[];
  rejected?: unknown[];
}): SendMessageResult {
  const accepted = (info.accepted ?? []).map(addressText).filter(Boolean);
  const rejected = (info.rejected ?? []).map(addressText).filter(Boolean);
  return {
    ...(info.messageId ? { message_id: info.messageId } : {}),
    accepted,
    rejected,
    partial: accepted.length > 0 && rejected.length > 0,
  };
}

export function normalizeSmtpSendError(
  error: unknown,
  sendAttempted: boolean,
): EmailToolError {
  const details =
    error && typeof error === "object"
      ? (error as { code?: unknown; responseCode?: unknown; command?: unknown })
      : {};
  const code = typeof details.code === "string" ? details.code.toUpperCase() : "";
  if (code === "EAUTH") {
    return new EmailToolError(
      "AUTH_FAILED",
      "Email provider authentication failed.",
    );
  }
  if (sendAttempted) {
    return new EmailToolError(
      "SEND_OUTCOME_UNKNOWN",
      "The SMTP connection failed after the send may have started. The message was not retried.",
    );
  }
  if (code === "ETIMEDOUT" || code === "ETIMEOUT" || code === "ESOCKETTIMEDOUT") {
    return new EmailToolError(
      "UPSTREAM_TIMEOUT",
      "Email provider request timed out.",
    );
  }
  return new EmailToolError(
    "UPSTREAM_UNAVAILABLE",
    "Email provider is unavailable.",
  );
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

  async getMessage(options: GetMessageOptions): Promise<EmailMessageDetail> {
    const reference = decodeMessageReference(options.messageId);
    if (
      reference.accountId !== this.account.id ||
      reference.folderId !== options.folderId
    ) {
      throw new EmailToolError(
        "MESSAGE_REFERENCE_STALE",
        "The message reference does not belong to the selected mailbox.",
      );
    }

    return this.withImap(async (client) => {
      const mailbox = await client.mailboxOpen(options.folderId, {
        readOnly: true,
      });

      if (String(mailbox.uidValidity) !== reference.uidValidity) {
        throw new EmailToolError(
          "MESSAGE_REFERENCE_STALE",
          "The message reference is stale because the mailbox identity changed.",
        );
      }

      const metadata = await client.fetchOne(
        reference.uid,
        {
          uid: true,
          envelope: true,
          flags: true,
          size: true,
          bodyStructure: true,
          headers: ["references"],
        },
        { uid: true },
      );

      if (!metadata) {
        throw new EmailToolError(
          "MESSAGE_NOT_FOUND",
          "The requested email message was not found.",
        );
      }

      const envelope = metadata.envelope;
      const flags = metadata.flags ?? new Set<string>();
      const date = envelope?.date
        ? new Date(envelope.date).toISOString()
        : undefined;
      const attachments = structureAttachmentMetadata(metadata.bodyStructure);
      const readableParts = selectReadableBodyParts(metadata.bodyStructure);

      let normalized: NormalizedMessagePayload;
      if (readableParts.length === 0) {
        normalized = {
          body: unavailableMessageBody(
            hasOversizedReadableBodyPart(metadata.bodyStructure)
              ? "message_body_too_large"
              : "body_not_found",
          ),
          attachments: [],
          reply_to: [],
        };
      } else {
        const bodyMessage = await client.fetchOne(
          reference.uid,
          {
            bodyParts: readableParts.map((part) => ({
              key: part.part,
              start: 0,
              maxLength: MAX_SOURCE_BYTES + 1,
            })),
          },
          { uid: true },
        );

        normalized = await normalizeFetchedBodyParts(
          readableParts,
          bodyMessage && bodyMessage.bodyParts
            ? bodyMessage.bodyParts
            : new Map<string, Uint8Array>(),
        );
      }

      const references = parseReferencesHeader(metadata.headers);
      return {
        message_id: options.messageId,
        folder_id: options.folderId,
        ...(envelope?.subject ? { subject: envelope.subject } : {}),
        from: normalizeAddresses(envelope?.from),
        to: normalizeAddresses(envelope?.to),
        cc: normalizeAddresses(envelope?.cc),
        reply_to: normalizeAddresses(envelope?.replyTo),
        ...(date ? { date } : {}),
        unread: !flags.has("\\Seen"),
        flagged: flags.has("\\Flagged"),
        has_attachments: attachments.length > 0,
        ...(metadata.size != null ? { size_bytes: metadata.size } : {}),
        ...(envelope?.messageId
          ? { internet_message_id: envelope.messageId }
          : {}),
        ...(envelope?.inReplyTo
          ? { in_reply_to: envelope.inReplyTo }
          : {}),
        ...(references ? { references } : {}),
        body: normalized.body,
        attachments,
      };
    });
  }

  async modifyMessages(
    options: ModifyMessagesOptions,
  ): Promise<ModifyMessagesResult> {
    return this.withImap(async (client) => {
      const mailbox = await client.mailboxOpen(options.folderId, {
        readOnly: false,
      });
      const uids = validateMutationReferences(
        this.account.id,
        options.folderId,
        options.messageIds,
        mailbox.uidValidity,
      );

      let destination: string | undefined;
      if (options.action === "move") {
        if (!options.targetFolderId) {
          throw new EmailToolError(
            "FOLDER_NOT_FOUND",
            "A target folder is required for move.",
          );
        }
        const folders = await client.list();
        const target = folders.find(
          (folder) =>
            folder.path === options.targetFolderId &&
            !folder.flags.has("\\Noselect"),
        );
        if (!target) {
          throw new EmailToolError(
            "FOLDER_NOT_FOUND",
            "The target email folder was not found.",
          );
        }
        destination = target.path;
      } else if (options.action === "trash") {
        const folders = await client.list();
        destination = trashPath(folders);
        if (!destination) {
          throw new EmailToolError(
            "TRASH_NOT_AVAILABLE",
            "The email provider does not expose a recoverable Trash folder.",
          );
        }
      }

      let sideEffectMayHaveStarted = false;
      try {
        switch (options.action) {
          case "mark_read":
            sideEffectMayHaveStarted = true;
            await client.messageFlagsAdd(uids, ["\\Seen"], {
              uid: true,
              silent: true,
            });
            break;
          case "mark_unread":
            sideEffectMayHaveStarted = true;
            await client.messageFlagsRemove(uids, ["\\Seen"], {
              uid: true,
              silent: true,
            });
            break;
          case "flag":
            sideEffectMayHaveStarted = true;
            await client.messageFlagsAdd(uids, ["\\Flagged"], {
              uid: true,
              silent: true,
            });
            break;
          case "unflag":
            sideEffectMayHaveStarted = true;
            await client.messageFlagsRemove(uids, ["\\Flagged"], {
              uid: true,
              silent: true,
            });
            break;
          case "move":
          case "trash":
            sideEffectMayHaveStarted = true;
            await client.messageMove(uids, destination!, { uid: true });
            break;
        }
      } catch (error) {
        if (error instanceof EmailToolError) throw error;
        if (sideEffectMayHaveStarted) {
          throw new EmailToolError(
            "MODIFY_OUTCOME_UNKNOWN",
            "The mailbox connection failed after the mutation may have been accepted. The operation was not retried.",
          );
        }
        throw error;
      }

      return {
        action: options.action,
        modified_count: uids.length,
        ...(destination ? { target_folder_id: destination } : {}),
      };
    });
  }


  async sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    const transporter = nodemailer.createTransport(
      buildSmtpTransportOptions(this.account),
    );
    try {
      try {
        await transporter.verify();
      } catch (error) {
        throw normalizeSmtpSendError(error, false);
      }

      let sendAttempted = false;
      try {
        sendAttempted = true;
        const info = await transporter.sendMail({
          from: options.from,
          to: options.to.map((value) => value.address),
          cc: options.cc.map((value) => value.address),
          bcc: options.bcc.map((value) => value.address),
          subject: options.subject,
          text: options.bodyText,
          ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
          ...(options.references ? { references: options.references } : {}),
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        return normalizeSmtpSendResult(info);
      } catch (error) {
        if (error instanceof EmailToolError) throw error;
        throw normalizeSmtpSendError(error, sendAttempted);
      }
    } finally {
      transporter.close();
    }
  }

}

export function createImapSmtpProvider(
  account: ResolvedEmailAccount,
): EmailProvider {
  return new ImapSmtpProvider(account);
}
