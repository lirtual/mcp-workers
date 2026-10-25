# ssh-mcp-worker context

EdgeSSH upstream remains the sole owner and writer of its encrypted host catalog.
SSH MCP independently performs fixed SELECT-only D1 reads using a separately configured copy of EdgeSSH's original encryption key, verifies the pinned fingerprint and executes bounded SSH/SFTP operations.
This requires explicit trust in SSH MCP with the same key that also protects other EdgeSSH encrypted data.
No custom EdgeSSH RPC, fork source changes, or credential copy via HTTP is part of the integration.
The D1 binding is technically write-capable, even though this app only uses SELECT.
