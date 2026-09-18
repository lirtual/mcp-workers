# Email MCP Worker

Cloudflare-native multi-account email MCP server.

v0.1 starts read-only by default. Account credentials live only in the EMAIL_ACCOUNTS_CONFIG Cloudflare Runtime Secret. The Worker accepts QQ Mail, Gmail, iCloud Mail, Fastmail, and explicit custom IMAP/SMTP endpoints using encrypted transport. Provider OAuth onboarding is outside v0.1.

Required Runtime Secrets:

- MCP_ACCESS_TOKEN
- EMAIL_ACCOUNTS_CONFIG

Non-secret feature gates:

- EMAIL_ALLOW_MODIFY=false
- EMAIL_ALLOW_SEND=false

The initial public tool is email_accounts. Later tickets add folders, search, read, modification, send, and respond while keeping the final public surface provider-neutral.
