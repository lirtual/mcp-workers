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

export interface EmailProvider {
  listFolders(options: ListFoldersOptions): Promise<EmailFolder[]>;
  searchMessages(options: SearchMessagesOptions): Promise<SearchMessagesResult>;
  getMessage(options: GetMessageOptions): Promise<EmailMessageDetail>;
}

export type EmailProviderFactory = (
  account: ResolvedEmailAccount,
) => EmailProvider;
