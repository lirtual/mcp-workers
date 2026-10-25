# Email MCP Worker — implementation under review

This independent Cloudflare Worker serves stateless Streamable HTTP at /mcp
and an Access-protected owner-only setup at email.lirtual.dpdns.org.

UNRELEASED candidate. No D1 binding, Cloudflare Access policy, OAuth client,
mailbox credentials or production custom route has been provisioned here.
DO NOT deploy this candidate to production.

## Current capabilities

- Strict Portal bearer boundary for MCP; Access JWT signature, audience, issuer,
  expiry and owner check for account setup; host and CSRF enforcement.
- OAuth PKCE/hashed single-use state; Gmail and Graph authorization; encrypted
  on-demand token lifecycle and local account removal.
- Gmail and Graph native search/read/folders/drafts/send/mark/trash. Gmail
  native threads and Graph reply/forward/move.
- Durable send fence; ambiguous sends never automatically replay. Bounded
  per-mailbox search (3 concurrent, max 8 accounts) with failure indicators.

NOT SUPPORTED: IMAP/SMTP, Graph native conversation read, Gmail reply/forward,
Gmail folder move, send attachments and Graph large attachment upload sessions.
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
Old accounts stay decryptable, but verified readback/re-encryption is not
implemented. NEVER retire the old key until migration verification exists.
If all copies of the key are lost, reauthorize accounts; no plaintext backup.

## Remaining release blockers

IMAP/SMTP SSRF-resistant native TLS and live integration; attachment send;
real provider OAuth/refresh/revoke and error injection; dedicated mailbox
end-to-end tests; 15-tool MCP inventory contract; D1 migrations and binding;
non-bypassable Access setup/OTP; Portal discovery; independent security review.
All deployment steps require separate release authorization.
