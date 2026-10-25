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
- Owner-only incremental credential key re-encryption with independently verified
  decrypt/readback and concurrency-safe conditional updates.
- Durable send fence; ambiguous sends never automatically replay. Bounded
  per-mailbox search (3 concurrent, max 8 accounts) with failure indicators.

NOT SUPPORTED: IMAP/SMTP, Gmail label-based folder moves, provider-specific
advanced mailbox administration, and verified cross-provider live integration.
Do not claim full Spec #279 acceptance from current code.

## Configuration and release gates

Create email-mcp-db D1; apply migrations/0001_accounts.sql; supply Worker DB
binding. Provision Cloudflare Access for all setup and OAuth callback paths
with owner OTP. Configure the email.lirtual.dpdns.org custom domain and
separate Portal registration. Neither is provided by this branch.

Required Worker Secrets: MCP_ACCESS_TOKEN, MAIL_ENCRYPTION_KEY (random canonical
base64 32-byte value), ACCESS_TEAM_DOMAIN, ACCESS_AUD, OWNER_EMAIL,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MICROSOFT_CLIENT_ID,
MICROSOFT_CLIENT_SECRET. Optional MAIL_KEY_ID, MAIL_ENCRYPTION_PREVIOUS_KEY,
MAIL_PREVIOUS_KEY_ID, MICROSOFT_TENANT. No credentials in Git/source/D1.

## Rotation/recovery

Keep former key in MAIL_ENCRYPTION_PREVIOUS_KEY and former key ID in
MAIL_PREVIOUS_KEY_ID when replacing MAIL_ENCRYPTION_KEY and MAIL_KEY_ID.
The owner setup includes bounded, resumable account/OAuth-session re-encryption
and readback. NEVER retire the old key until all remaining records are migrated
and verified in the target environment.
If all copies of the key are lost, reauthorize accounts; no plaintext backup.

## Remaining release blockers

IMAP/SMTP Workers-native TLS and DNS-rebinding-resistant live integration; real provider
OAuth/refresh/revoke, Graph upload-session and MIME interoperability testing;
dedicated mailbox end-to-end tests; D1 migrations and binding;
non-bypassable Access setup/OTP; Portal discovery; independent security review.
All deployment steps require separate release authorization.
