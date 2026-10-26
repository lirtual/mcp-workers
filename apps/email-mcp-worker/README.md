# Email MCP Worker — generic IMAP/SMTP

This Worker connects **non-Gmail, non-Outlook** email accounts via standard
IMAP/SMTP. Use the existing **ChatGPT Gmail** and **Outlook Email** plugins
for Google and Microsoft mailboxes instead. Those ChatGPT plugin connections
are independent of this Worker and are not credentials this Worker can invoke.

**Production release preparation:** Worker publishes only via the existing manual
GitHub Actions `Release Worker` gate on `main`; never deploy from a PR or an
unreviewed Cloudflare dashboard. The owner must stage five scoped GitHub
Environment Secrets for `email-mcp-worker` before the first release.
Release readback and MCP negative-auth validation are mandatory.
Mailbox read/send and Portal validation remain independent acceptance checks.

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
- For QQ, 163 and 126 IMAP hosts, server-side `SEARCH TEXT` may return unrelated
  messages. Search instead scans at most 5,000 **INBOX envelope headers** and
  matches subject/sender/recipient fields locally (never body or attachments).
  The per-account `search_scope: envelope` identifies this limitation; body-only
  matches are not supported on these hosts. A larger inbox fails with
  `result_too_large` (visible partial failure), never silently returns incomplete
  or unverified search hits. Other IMAP hosts use server-side TEXT and report
  `search_scope: full_text`.
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

Required Secrets: shared Repository `MCP_ACCESS_TOKEN` and Email Environment
`MAIL_ENCRYPTION_KEY` (32-byte random Base64). Required Email Environment
Variables: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`.
Optional rotation: `MAIL_KEY_ID`, `MAIL_ENCRYPTION_PREVIOUS_KEY`,
`MAIL_PREVIOUS_KEY_ID`. **No** `GOOGLE_CLIENT_*`, `MICROSOFT_CLIENT_*`,
OAuth state storage, provider-scoped credentials or compatibility tables.

Production D1 `email-mcp-db` is bound as `DB` with exactly two tables
(`mail_accounts` and `send_attempts`). Its reviewed migration is applied
through the same GitHub Actions release job. Setup uses
`email.lirtual.dpdns.org`; MCP uses `email-mcp.lirtual.dpdns.org`.
The previous temporary acceptance database is separate and must not be copied
without its encryption key; reconnect mailboxes in production, then securely
delete the temporary Worker, Access application, domains and D1.

## Release gate — not yet satisfied

Earlier [Cloudflare remote preview #40256001876](https://github.com/lirtual/mcp-workers/actions/runs/40256001876)
proved an earlier candidate's remote D1 migration/MCP auth/tool discovery,
not IMAP/SMTP operations. A subsequent [remote TLS probe #40258246368](https://github.com/lirtual/mcp-workers/actions/runs/40258246368)
showed **Gmail IMAP 993 TLS handshake only**, while unauthenticated SMTP 465/587
probes to Gmail, Microsoft and QQ failed. It did not prove generic SMTP
is universally unavailable or that actual mail auth or sends work.
Cloudflare explicitly blocks outbound TCP 25 but does not blanket-block
465/587: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/

### 2026-10-26 direct Cloudflare network acceptance (no mail credentials)

One-shot remote Wrangler development previews used fixed public endpoints, no
mailbox authentication and no mail submission. All preview sessions exited;
independent Cloudflare readback found **no** persisted probe Worker scripts
or Email D1 database.

| Target | Evidence | Status |
| --- | --- | --- |
| `imap.163.com:993`, `imap.qq.com:993`, `imap.mail.me.com:993` | Node `tls.connect` verified certificate handshake | All TLS OK |
| `smtp.163.com:465`, `smtp.qq.com:465`, `smtp.mail.me.com:465` | Node `tls.connect` verified certificate handshake | All TLS OK |
| `smtp.163.com:465` | Node TLS over hostname received SMTP `220` banner | OK |
| `smtp.163.com:465` | TLS over manually DNS-resolved / pinned numeric IP | **Blocked by Workers TCP proxy** |
| `smtp.163.com:465` | Unmodified Nodemailer transport, even with hostname | **ESOCKET: proxy request failed** |
| `smtp.163.com:465` | Nodemailer `verify()` with pre-established, hostname-verified Node TLS socket injected via `getSocket` | **Protocol verified, no AUTH** |
| `smtp.qq.com:587` | Nodemailer pre-established Node TCP socket, mandatory STARTTLS | **Protocol verified, no AUTH** |
| `smtp.163.com:587` | Same mandatory STARTTLS pre-socket approach | Greeting timed out |

### Security boundary decision and implementation (accepted 2026-10-26)

The owner approved replacing **strict DNS-to-connected-IP pinning**, which is
incompatible with the observed Workers TCP proxy behavior, with the following
explicitly narrower protections:

- Restrict remote ports to IMAP 993 and SMTP 465/587. Reject IP-literal inputs,
  local/test hostnames, and known native Google/Microsoft mail endpoints.
- Pre-resolve both IPv4 and IPv6 records over Cloudflare DoH and reject any
  non-public or unsafe result before initiating the mail connection.
- Allow the Workers runtime to resolve the verified hostname independently at
  connection time. Cloudflare's TCP runtime blocks private/loopback/Cloudflare
  destinations; this also forbids port 25.
- Verify TLS certificates against the requested hostname. IMAP uses ImapFlow's
  existing `createSocketsTransport()` over `cloudflare:sockets`; SMTP 465 uses a
  pre-established, hostname-verified Node TLS connection passed into Nodemailer
  via `getSocket`. SMTP 587 uses a preconnected TCP socket and Nodemailer's
  mandatory STARTTLS, with no authentication permitted before TLS.
- Never use a generic proxy, arbitrary redirect or disable TLS validation.
  Fail closed on DNS, TLS, socket, or login errors; avoid logging credentials.

**Residual limitation:** DNS prevalidation and connection-time resolution are
separate operations. Cloudflare's socket metadata does not expose a verifiable
numeric peer IP, so this is **not** strict IP pinning or a proof that DNS was
unchanged. Do not market it as such. TLS hostname validation and Cloudflare
destination blocking are the remaining enforcement layers.

The new ImapFlow native Cloudflare transport was also tested in a one-shot
remote preview against `imap.163.com:993` and `imap.qq.com:993`: **both
returned their authentic TLS-protected IMAP greeting** without credentials.
This only verifies the transport, not LOGIN, IMAP operations or sending.
The SMTP `getSocket` adapter has only been probed without authentication;
real mailbox tests are still required. No production Worker, D1 or mailbox
credential was deployed for these tests.

Acceptance still requires supported-provider live IMAP/SMTP authentication,
STARTTLS/hostname verification, read/search/attachments/UIDVALIDITY,
draft/send/reply/forward, failure injection and duplicate-send checks,
Access OTP, dedicated D1, Portal E2E, security review, and a separately
authorized GitHub Actions production release. Keep PR #284 Draft and
Issue #279 Open until those gates pass. Do not add extra proxies or workers
just to bypass an unsupported SMTP route.

## Production Portal registration
The manual `Release Worker` job attaches the deployed Worker as the `email`
upstream in the existing One-MCP Portal using the shared repository
`MCP_ACCESS_TOKEN`. It verifies the live inventory of 13 approved tools before
modifying the Portal. Existing Portal server mappings are preserved.
No separate Worker, secret, GitHub workflow or orchestration service is added.
