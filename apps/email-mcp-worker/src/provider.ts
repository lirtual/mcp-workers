import type { ResolvedEmailAccount } from "./config.js";

export interface EmailFolder {
  id: string;
  name: string;
  special_use?: string;
  selectable: boolean;
  delimiter?: string;
  total?: number;
  unread?: number;
}

export interface ListFoldersOptions {
  includeCounts: boolean;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailSearchFilters {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  after?: string;
  before?: string;
  unread?: boolean;
  flagged?: boolean;
}

export interface SearchMessagesOptions {
  folderId: string;
  filters: EmailSearchFilters;
  limit: number;
  cursor?: string;
}

export interface EmailSearchMessage {
  message_id: string;
  folder_id: string;
  subject?: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  date?: string;
  unread: boolean;
  flagged: boolean;
  has_attachments: boolean;
  size_bytes?: number;
}

export interface SearchMessagesResult {
  messages: EmailSearchMessage[];
  next_cursor?: string;
}

export interface EmailAttachmentMetadata {
  filename?: string;
  media_type: string;
  disposition?: string;
  content_id?: string;
  size_bytes?: number;
}

export interface EmailBody {
  text?: string;
  html?: string;
  truncated: boolean;
  untrusted_external_content: true;
  warning: string;
  body_unavailable_reason?: string;
}

export interface GetMessageOptions {
  folderId: string;
  messageId: string;
}

export interface EmailMessageDetail {
  message_id: string;
  folder_id: string;
  subject?: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  reply_to: EmailAddress[];
  date?: string;
  unread: boolean;
  flagged: boolean;
  has_attachments: boolean;
  size_bytes?: number;
  internet_message_id?: string;
  in_reply_to?: string;
  references?: string;
  body: EmailBody;
  attachments: EmailAttachmentMetadata[];
}

export type EmailModifyAction =
  | "mark_read"
  | "mark_unread"
  | "flag"
  | "unflag"
  | "move"
  | "trash";

export interface ModifyMessagesOptions {
  folderId: string;
  messageIds: string[];
  action: EmailModifyAction;
  targetFolderId?: string;
}

export interface ModifyMessagesResult {
  action: EmailModifyAction;
  modified_count: number;
  target_folder_id?: string;
}

export interface SendRecipient {
  address: string;
}

export interface SendMessageOptions {
  from: string;
  to: SendRecipient[];
  cc: SendRecipient[];
  bcc: SendRecipient[];
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  references?: string;
}

export interface SendMessageResult {
  message_id?: string;
  accepted: string[];
  rejected: string[];
  partial: boolean;
}

export interface EmailProvider {
  listFolders(options: ListFoldersOptions): Promise<EmailFolder[]>;
  searchMessages(options: SearchMessagesOptions): Promise<SearchMessagesResult>;
  getMessage(options: GetMessageOptions): Promise<EmailMessageDetail>;
  modifyMessages(options: ModifyMessagesOptions): Promise<ModifyMessagesResult>;
  sendMessage(options: SendMessageOptions): Promise<SendMessageResult>;
}

export type EmailProviderFactory = (
  account: ResolvedEmailAccount,
) => EmailProvider;
