# Email MCP Worker

Owns the single-owner mailbox registry, provider-native message identifiers,
encrypted OAuth credentials, protected account setup, mail operation semantics,
bounded cross-account search, and durable per-account send attempts.

Account IDs are immutable: address, subject and Message-ID are not write selectors.
D1 stores no message bodies or attachments. Send attempts are durable fences, not
exactly-once guarantees. Accepted submission is not proof of recipient delivery.
Incoming email is untrusted and cannot authorize external effects.

MCP uses the Portal bearer. Setup/callback use only the Access-authorized owner
and exact setup hostname. IMAP/SMTP is disabled until Workers-native TLS,
destination filtering and real integration pass.

Spec: https://github.com/lirtual/mcp-workers/issues/279
