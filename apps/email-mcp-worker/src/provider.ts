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

export interface EmailProvider {
  listFolders(options: ListFoldersOptions): Promise<EmailFolder[]>;
}

export type EmailProviderFactory = (
  account: ResolvedEmailAccount,
) => EmailProvider;
