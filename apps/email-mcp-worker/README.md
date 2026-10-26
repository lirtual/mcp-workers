# Email MCP Worker — implementation under review

This independent Cloudflare Worker serves stateless Streamable HTTP at /mcp
and an Access-protected owner-only setup at email.lirtual.dpdns.org.

UNRELEASED candidate. No D1 binding, Cloudflare Access policy, OAuth client,
mailbox credentials or production custom route has been provisioned here.
DO NOT deploy this candidate to production.

## Current capabilities

- Strict Portal bearer boundary for MCP; Access JWT signature, audience, issuer,
  expiry and owner check for account setup; host and CSRF enforcement.
- OAuth PKCE/hashed single-use state; Gmail and Graph authorization/reconnection; encrypted
  on-demand token lifecycle and local account removal.
- Gmail and Graph native search/read/folders/drafts/send/mark/trash, Gmail
  native reply/forward and Graph native conversation lookup, reply/forward/move.
- Bounded 5 MiB total per-operation attachments for send, drafts, reply and
  forward: validated inline Base64 or stable same-mailbox references only.
  Gmail uses safe multipart MIME; Graph uses direct file attachment below 3 MB
  and trusted upload sessions for larger files; no arbitrary URL downloads.
  Graph mail_get enumerates up to 20 attachment IDs (including inline-only files)
  using metadata-only queries and reports attachments_truncated if more exist;
  attachment_get fetches selected file bytes on demand.
- Owner-only incremental credential key re-encryption with independently verified
  decrypt/readback and concurrency-safe conditional updates.
- Durable send fence; ambiguous sends never automatically replay. Bounded
  per-mailbox search (3 concurrent, max 8 accounts) with failure indicators.

- Generic IMAP 993 and SMTP 465/587 candidate adapter based on ImapFlow,
  Nodemailer and postal-mime. Native IMAP references contain folder, UIDVALIDITY
  and UID; operations cover search (INBOX), get, attachments, folders, mark,
  conditional move/trash and APPEND draft (only where server capabilities permit).
  IMAP reply/forward uses SMTP with an explicit recipient; replies validate the
  source Reply-To and RFC Message-ID, without inferring native conversations.
  SMTP supports text + attachments with a durable pre-dispatch fence.
- IMAP/SMTP onboarding checks both protocol logins before storing any encrypted
  credentials. Each connection resolves and validates public DNS addresses,
  connects to a pinned IP, and supplies the original host for TLS SNI/certificate
  verification. STARTTLS is mandatory on 587; insecure fallback is forbidden.
- **Generic IMAP/SMTP remains unverified for production.** In actual
  Cloudflare remote preview, a no-login IMAP TLS handshake to Gmail port 993
  succeeded, but credential-free SMTP 465/587 probes failed against Gmail,
  Microsoft and QQ. These observations do not prove all SMTP servers will fail
  or that authenticated mail delivery works. The adapter stays a candidate.

NOT SUPPORTED: Gmail label-based folder moves, provider-specific advanced mailbox
administration, and verified cross-provider live integration.
Do not claim full Spec #279 acceptance from current code.

## Configuration and release gates

Create email-mcp-db D1; apply migrations/0001_accounts.sql; supply Worker DB
binding. Provision Cloudflare Access for all setup and OAuth callback paths
with owner OTP. Configure the email.lirtual.dpdns.org custom domain and
separate Portal registration. Neither is provided by this branch.

Required Worker Secrets: MCP_ACCESS_TOKEN, MAIL_ENCRYPTION_KEY (random canonical
base64 32-byte value), ACCESS_TEAM_DOMAIN, ACCESS_AUD, OWNER_EMAIL,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MICROSOFT_CLIENT_ID,
MICROSOFT_CLIENT_SECRET for their corresponding providers. Generic IMAP/SMTP
uses per-account encrypted app credentials (not additional Worker secrets).
Optional MAIL_KEY_ID, MAIL_ENCRYPTION_PREVIOUS_KEY,
MAIL_PREVIOUS_KEY_ID, MICROSOFT_TENANT. No credentials in Git/source/D1.

## Verified acceptance and external OAuth prerequisites (2026-10-26)

- Candidate CI `#40257839917` passed after replacing the seven
  Workers-incompatible `fetch redirect: 'error'` settings with
  `redirect: 'manual'`; all upstream 3xx responses remain rejected.
- Local Workerd/D1/MCP acceptance `#40253525289` passed. Remote Cloudflare
  preview/D1/MCP `#40256001876` passed on its pinned earlier candidate.
  Latest remote TCP/TLS probe `#40258246368` failed overall because SMTP
  465/587 was unsuccessful; Gmail IMAP 993 TLS succeeded. Both remote test
  database migrations and disposable D1 cleanup succeeded, with no
  production Worker deployed.
- Cloudflare documents that outbound TCP port 25 is prohibited. It does
  **not** declare every SMTP port 465/587 universally prohibited. Do not
  infer production SMTP support from local tests or a TLS handshake.
- For Gmail OAuth E2E, create an independent Google OAuth **Web application**
  with the exact redirect URI
  `https://email.lirtual.dpdns.org/oauth/callback`, enable Gmail API,
  and request `https://www.googleapis.com/auth/gmail.modify`. This is a
  **restricted** scope; a Google app in external Testing mode must include
  the intended test account, and refresh tokens can expire under testing
  limits. Do not use an existing personal mailbox as an implicit test.
- For Microsoft Graph OAuth E2E, create a separate Microsoft identity
  **Web application** with that exact redirect URI and **delegated**
  `offline_access User.Read Mail.ReadWrite Mail.Send` permissions. Do not
  replace delegated access with broad application-level permissions.
- Set client IDs/secrets only as the respective Worker Secrets after the
  Access-protected callback is deliberately provisioned. Nothing in this
  README authorizes live account consent, email writes, a production route,
  Portal registration, or merging the Draft PR.

## Rotation/recovery

Keep former key in MAIL_ENCRYPTION_PREVIOUS_KEY and former key ID in
MAIL_PREVIOUS_KEY_ID when replacing MAIL_ENCRYPTION_KEY and MAIL_KEY_ID.
The owner setup includes bounded, resumable account/OAuth-session re-encryption
and readback. NEVER retire the old key until all remaining records are migrated
and verified in the target environment.
If all copies of the key are lost, reauthorize accounts; no plaintext backup.

## Remaining release blockers

Real Workers-native IMAP/SMTP TLS and DNS-pinned connection verification,
including certificate/STARTTLS, UIDVALIDITY changes, server capability
differences, and SMTP submission fault injection; real provider OAuth/refresh/
revoke, Graph upload-session and MIME interoperability testing;
dedicated mailbox end-to-end tests; D1 migrations and binding;
non-bypassable Access setup/OTP; Portal discovery; independent security review.
All deployment steps require separate release authorization.
