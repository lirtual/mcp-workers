# Email MCP Worker — IMAP/SMTP only (unreleased)

This Worker connects **non-Gmail, non-Outlook** email accounts via standard
IMAP/SMTP. Use the existing **ChatGPT Gmail** and **Outlook Email** plugins
for Google and Microsoft mailboxes instead. Those ChatGPT plugin connections
are independent of this Worker and are not credentials this Worker can invoke.

**Draft PR #284 is not release-ready.** No Email Worker, production D1 binding,
mailbox credential, public DNS route or Portal registration has been deployed.

## Scope

- Single owner and multiple generic IMAP/SMTP accounts.
- IMAP over port 993 and SMTP submission over TLS 465 or mandatory STARTTLS 587.
  No port 25, insecure TLS fallback, arbitrary TCP proxy, OAuth client or second orchestrator.
- Owner-only account setup at `https://email.lirtual.dpdns.org/setup` behind
  Cloudflare Access email OTP. No OAuth browser redirects or callback route.
- Credentials and account configuration stored in D1 under AES-GCM with a
  Worker Secret encryption key; no stored message body or attachment copies.
- Provider-native folder, UIDVALIDITY and UID message identity.
- MCP tools: `account_list`, `capabilities_get`, `mail_search`,
  `mail_get`, `folder_list`, `attachment_get`, `draft_create`,
  `mail_send`, `mail_reply`, `mail_forward`, `mail_mark`,
  `mail_move`, `mail_trash` (**13**).
- Search up to 8 explicitly selected accounts, bounded fanout and explicit
  per-mailbox partial failures; read body safely as text.
- Send attempts are D1-fenced by caller-supplied `request_id`; ambiguous
  submissions never automatically retry. Never promise exactly-once delivery.
- Up to 5 MiB raw attachment bytes per request; no URL-based download.
  IMAP Drafts requires Drafts folder/UIDPLUS; draft attachments and edits,
  and inferred conversation threads, are not supported.

## Onboarding and provider exclusions

The only account type is `imap_smtp`. The owner supplies mailbox address,
IMAP host, SMTP host, username and app password; both protocol authentications
must pass before storing encrypted credentials. Reconnection must preserve
account identity and account ID. Built-in Google/Microsoft OAuth, Graph, Gmail
API, tokens, sessions and tenant scopes have been removed. Known native
Gmail/Outlook addresses and endpoints are rejected at setup.

Other domains (e.g. QQ, 163, 126, iCloud, custom mail) are **candidates**,
not automatically verified working providers. App-password availability and
IMAP/SMTP server capabilities differ.

## Security and configuration

A Cloudflare Access Self-hosted app currently exists:
- Name: `Email MCP Setup` (renamed and independently verified on Cloudflare)
- Domain: `email.lirtual.dpdns.org`
- Access AUD: `cea1cd806f0f68552c5bed2acd917afcaf8e18a7eda3fb19f5c9704c3a00cd1b`
- Team domain: `lirtualzero.cloudflareaccess.com`
- OTP owner-only: `lirtual@outlook.com`; 15-minute session.

The Worker must verify Access JWT signature/issuer/audience/owner and deny
alternate setup hosts. MCP uses separate Portal bearer authentication; it
must not rely on Access cookies. All setup mutations require same-origin CSRF.

Required Worker Secrets: `MCP_ACCESS_TOKEN`, `MAIL_ENCRYPTION_KEY`
(random 32-byte base64), `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`.
Optional rotation: `MAIL_KEY_ID`, `MAIL_ENCRYPTION_PREVIOUS_KEY`,
`MAIL_PREVIOUS_KEY_ID`. **No** `GOOGLE_CLIENT_*`, `MICROSOFT_CLIENT_*`,
OAuth state storage, provider-scoped credentials or compatibility tables.

Create an isolated Email D1 database and apply `migrations/0001_accounts.sql`
before any deployment; it has only `mail_accounts` and `send_attempts`.
No live Email D1 has ever been deployed, so no schema compatibility migration
or historical OAuth records are required.

## Release gate — not yet satisfied

Earlier [Cloudflare remote preview #40256001876](https://github.com/lirtual/mcp-workers/actions/runs/40256001876)
proved an earlier candidate's remote D1 migration/MCP auth/tool discovery,
not IMAP/SMTP operations. A subsequent [remote TLS probe #40258246368](https://github.com/lirtual/mcp-workers/actions/runs/40258246368)
showed **Gmail IMAP 993 TLS handshake only**, while unauthenticated SMTP 465/587
probes to Gmail, Microsoft and QQ failed. It did not prove generic SMTP
is universally unavailable or that actual mail auth or sends work.
Cloudflare explicitly blocks outbound TCP 25 but does not blanket-block
465/587: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

Acceptance still requires supported-provider live IMAP/SMTP authentication,
STARTTLS/hostname verification, read/search/attachments/UIDVALIDITY,
draft/send/reply/forward, failure injection and duplicate-send checks,
Access OTP, dedicated D1, Portal E2E, security review, and a separately
authorized GitHub Actions production release. Keep PR #284 Draft and
Issue #279 Open until those gates pass. Do not add extra proxies or workers
just to bypass an unsupported SMTP route.
