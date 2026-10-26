# Email MCP Worker

Owns single-owner generic IMAP/SMTP mailbox credentials and account registry,
message operations, bounded on-demand search, and D1-fenced send attempts.
Gmail and Outlook mail are handled outside this Worker by the user's already
connected ChatGPT plugins. The plugins are not callable by this Worker.

Account IDs are immutable. Message identity includes IMAP folder, UIDVALIDITY
and UID. D1 stores no message bodies or attachments. Outbound send state
is not proof of recipient delivery, and indeterminate sends are never replayed.

The MCP endpoint uses Portal bearer; account setup uses owner-only Cloudflare
Access JWT, exact hostname and CSRF. Mail connections require public A/AAAA
DNS prevalidation, fixed IMAP 993 / SMTP 465 or 587 ports, hostname-validated
TLS, and Workers runtime destination blocking. DNS prevalidation and connection
resolution are separate: numeric peer-IP pinning is not guaranteed, and the
residual DNS-rebinding limitation is documented in the README and Spec #279.
Provider acceptance remains blocked until live authenticated protocol tests pass.

Spec: https://github.com/lirtual/mcp-workers/issues/279
