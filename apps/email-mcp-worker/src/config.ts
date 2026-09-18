import { z } from "zod";
import { EmailToolError } from "./errors.js";

export type EmailProviderName = "qq" | "gmail" | "icloud" | "fastmail" | "custom";
export type ImapTlsMode = "implicit";
export type SmtpTlsMode = "implicit" | "starttls";

export interface ImapEndpoint {
  host: string;
  port: number;
  tls: ImapTlsMode;
}

export interface SmtpEndpoint {
  host: string;
  port: number;
  tls: SmtpTlsMode;
}

export interface ResolvedEmailAccount {
  id: string;
  provider: EmailProviderName;
  displayName: string;
  address: string;
  enabled: boolean;
  auth: {
    type: "password";
    username: string;
    password: string;
  };
  senders: string[];
  imap: ImapEndpoint;
  smtp: SmtpEndpoint;
}

export interface EmailCatalog {
  defaultAccount: string;
  accounts: ResolvedEmailAccount[];
}

export interface EmailFeatureGates {
  allowModify: boolean;
  allowSend: boolean;
}

export type EmailConfigErrorCode =
  | "email_config_not_configured"
  | "email_config_invalid";

export class EmailConfigError extends Error {
  constructor(
    public readonly code: EmailConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EmailConfigError";
  }
}

const providerSchema = z.enum(["qq", "gmail", "icloud", "fastmail", "custom"]);
const accountIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const imapEndpointSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    tls: z.literal("implicit"),
  })
  .strict();

const smtpEndpointSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    tls: z.enum(["implicit", "starttls"]),
  })
  .strict();

const authSchema = z
  .object({
    type: z.literal("password"),
    username: z.string().min(1).max(320).optional(),
    password: z.string().min(1),
  })
  .strict();

const accountSchema = z
  .object({
    provider: providerSchema,
    display_name: z.string().min(1).max(100).optional(),
    address: z.string().email().max(320),
    enabled: z.boolean().default(true),
    auth: authSchema,
    senders: z.array(z.string().email().max(320)).min(1).max(20).optional(),
    imap: imapEndpointSchema.optional(),
    smtp: smtpEndpointSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === "custom" && !value.imap) {
      ctx.addIssue({
        code: "custom",
        path: ["imap"],
        message: "custom provider requires an explicit implicit-TLS IMAP endpoint",
      });
    }
    if (value.provider === "custom" && !value.smtp) {
      ctx.addIssue({
        code: "custom",
        path: ["smtp"],
        message: "custom provider requires an explicit encrypted SMTP endpoint",
      });
    }
  });

const catalogSchema = z
  .object({
    default_account: accountIdSchema,
    accounts: z.record(accountIdSchema, accountSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const entries = Object.entries(value.accounts);
    if (entries.length < 1 || entries.length > 20) {
      ctx.addIssue({
        code: "custom",
        path: ["accounts"],
        message: "accounts must contain 1 to 20 configured accounts",
      });
    }

    const defaultAccount = value.accounts[value.default_account];
    if (!defaultAccount) {
      ctx.addIssue({
        code: "custom",
        path: ["default_account"],
        message: "default_account must identify a configured account",
      });
    } else if (!defaultAccount.enabled) {
      ctx.addIssue({
        code: "custom",
        path: ["default_account"],
        message: "default_account must identify an enabled account",
      });
    }
  });

interface ProviderPreset {
  imap: ImapEndpoint;
  smtp: SmtpEndpoint;
}

export const PROVIDER_PRESETS: Record<
  Exclude<EmailProviderName, "custom">,
  ProviderPreset
> = {
  qq: {
    imap: { host: "imap.qq.com", port: 993, tls: "implicit" },
    smtp: { host: "smtp.qq.com", port: 465, tls: "implicit" },
  },
  gmail: {
    imap: { host: "imap.gmail.com", port: 993, tls: "implicit" },
    smtp: { host: "smtp.gmail.com", port: 465, tls: "implicit" },
  },
  icloud: {
    imap: { host: "imap.mail.me.com", port: 993, tls: "implicit" },
    smtp: { host: "smtp.mail.me.com", port: 587, tls: "starttls" },
  },
  fastmail: {
    imap: { host: "imap.fastmail.com", port: 993, tls: "implicit" },
    smtp: { host: "smtp.fastmail.com", port: 465, tls: "implicit" },
  },
};

export function featureEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function parseEmailAccountsConfig(raw: string | undefined): EmailCatalog {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new EmailConfigError(
      "email_config_not_configured",
      "Email account configuration is not configured.",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new EmailConfigError(
      "email_config_invalid",
      "Email account configuration is invalid.",
    );
  }

  const parsed = catalogSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new EmailConfigError(
      "email_config_invalid",
      "Email account configuration is invalid.",
    );
  }

  const accounts = Object.entries(parsed.data.accounts).map(([id, account]) => {
    const preset =
      account.provider === "custom" ? undefined : PROVIDER_PRESETS[account.provider];
    const imap = account.imap ?? preset?.imap;
    const smtp = account.smtp ?? preset?.smtp;

    if (!imap || !smtp) {
      throw new EmailConfigError(
        "email_config_invalid",
        "Email account configuration is invalid.",
      );
    }

    return {
      id,
      provider: account.provider,
      displayName: account.display_name ?? id,
      address: account.address,
      enabled: account.enabled,
      auth: {
        type: "password" as const,
        username: account.auth.username ?? account.address,
        password: account.auth.password,
      },
      senders: account.senders ?? [account.address],
      imap,
      smtp,
    } satisfies ResolvedEmailAccount;
  });

  return {
    defaultAccount: parsed.data.default_account,
    accounts,
  };
}

export function resolveAccount(
  catalog: EmailCatalog,
  accountId?: string,
): ResolvedEmailAccount {
  const id = accountId ?? catalog.defaultAccount;
  const account = catalog.accounts.find((candidate) => candidate.id === id);
  if (!account) {
    throw new EmailToolError("ACCOUNT_NOT_FOUND", "Email account was not found.");
  }
  if (!account.enabled) {
    throw new EmailToolError("ACCOUNT_DISABLED", "Email account is disabled.");
  }
  return account;
}

export function publicAccounts(
  catalog: EmailCatalog,
  gates: EmailFeatureGates,
) {
  return catalog.accounts
    .filter((account) => account.enabled)
    .map((account) => ({
      id: account.id,
      display_name: account.displayName,
      address: account.address,
      provider: account.provider,
      default: account.id === catalog.defaultAccount,
      read_enabled: true,
      modify_enabled: gates.allowModify,
      send_enabled: gates.allowSend,
    }));
}
