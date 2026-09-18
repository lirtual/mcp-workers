# Email MCP Worker

Cloudflare-native, provider-neutral email MCP server for bounded IMAP reads, opt-in mailbox mutation, and explicitly confirmed SMTP send.

## Runtime configuration

Required Cloudflare Runtime Secrets:

- `MCP_ACCESS_TOKEN`
- `EMAIL_ACCOUNTS_CONFIG`

Non-secret feature gates default to read-only operation:

- `EMAIL_ALLOW_MODIFY=false`
- `EMAIL_ALLOW_SEND=false`

`EMAIL_ACCOUNTS_CONFIG` is one JSON object. Credentials and endpoints are never returned by MCP tools.

```json
{
  "default_account": "personal",
  "accounts": {
    "personal": {
      "provider": "qq",
      "address": "name@qq.com",
      "display_name": "Personal QQ",
      "auth": {
        "type": "password",
        "password": "<QQ app authorization code>"
      }
    }
  }
}
```

Supported provider presets in v0.1 are `qq`, `gmail`, `icloud`, and `fastmail`. `custom` accepts explicit IMAP/SMTP endpoints from the secret catalog. All provider connections use encrypted transport. Provider OAuth onboarding is outside v0.1.

Optional `senders` entries restrict the allowed From identities for an account. If omitted, the configured account address is the only allowed sender.

## Public MCP tools

v0.1 exposes exactly seven provider-neutral tools:

- `email_accounts`
- `email_folders`
- `email_search`
- `email_get`
- `email_modify`
- `email_send`
- `email_respond`

There are no QQ/Gmail/iCloud-specific aliases.

## Safety boundaries

Reads are bounded and do not intentionally mark messages read. Message bodies are returned as untrusted external data and attachment bytes are never returned. Message identity uses mailbox UIDVALIDITY + UID semantics so stale references fail explicitly instead of addressing a different message.

Mailbox modification is unavailable unless `EMAIL_ALLOW_MODIFY=true`. The modify surface is limited to mark read/unread, flag/unflag, move, and recoverable Trash. Permanent delete/EXPUNGE is not exposed. Trash requires MCP protocol-level user confirmation.

Sending and responding are unavailable unless `EMAIL_ALLOW_SEND=true`. Outbound mail is plain text only, bounded to 20 total recipients and 128 KiB UTF-8 body content, and requires MCP protocol-level user confirmation. Sender identities are restricted by the account catalog. Attachment upload/forwarding, HTML compose, custom headers, bulk send, drafts, and scheduled send are outside v0.1.

Ambiguous mutation or SMTP outcomes are returned as unknown outcome and are not automatically retried.

## Verification

Run the complete app gate without real mailbox credentials:

```bash
pnpm --filter email-mcp-worker check
```

The check includes TypeScript, ESLint, automated/contract tests, and Wrangler dry-run. Live mailbox acceptance is separate and must use a deployed Worker plus a dedicated test mailbox/message.

After deployment, use the root smoke runner only with an explicitly selected read-only tool, for example:

```bash
MCP_ACCESS_TOKEN='<token>' pnpm smoke:mcp -- \
  --url 'https://email-mcp-worker.<workers-subdomain>.workers.dev/mcp' \
  --tool email_folders \
  --args-json '{}'
```

Workers logs must not include access tokens, mailbox passwords, subjects, bodies, recipient lists, or raw private provider responses.
