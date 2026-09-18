import { ImapFlow, type ListResponse } from "imapflow";
import type { ResolvedEmailAccount } from "./config.js";
import { EmailToolError } from "./errors.js";
import type {
  EmailFolder,
  EmailProvider,
  ListFoldersOptions,
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
  return {
    id: entry.path,
    name: entry.name,
    ...(specialUse(entry) ? { special_use: specialUse(entry) } : {}),
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

export function normalizeImapError(error: unknown): EmailToolError {
  const details =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          responseStatus?: unknown;
          authenticationFailed?: unknown;
        })
      : {};
  const code = typeof details.code === "string" ? details.code.toUpperCase() : "";
  const responseStatus =
    typeof details.responseStatus === "string"
      ? details.responseStatus.toUpperCase()
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

  return new EmailToolError(
    "UPSTREAM_UNAVAILABLE",
    "Email provider is unavailable.",
  );
}

export class ImapSmtpProvider implements EmailProvider {
  constructor(private readonly account: ResolvedEmailAccount) {}

  async listFolders(options: ListFoldersOptions): Promise<EmailFolder[]> {
    const client = new ImapFlow({
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

    let connected = false;
    try {
      await client.connect();
      connected = true;
      const folders = await client.list(
        options.includeCounts
          ? { statusQuery: { messages: true, unseen: true } }
          : undefined,
      );
      return folders.map((folder) =>
        normalizeFolder(folder, options.includeCounts),
      );
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
}

export function createImapSmtpProvider(
  account: ResolvedEmailAccount,
): EmailProvider {
  return new ImapSmtpProvider(account);
}
