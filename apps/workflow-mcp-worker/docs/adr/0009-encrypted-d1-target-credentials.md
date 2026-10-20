---
status: accepted
date: 2026-10-20
---

# Persist dynamic MCP target credentials encrypted in D1 using an independent Worker secret

Workflow MCP stores the single owner's target-specific MCP credentials as encrypted values in D1, with a separate Cloudflare Worker Secret as the master encryption key (**Q21=A**). This provides runtime create/update of target credentials without launching a separate Secrets Store or Vault service. The Portal access token is **not** the encryption master key and is never implicitly forwarded to target servers. D1 definition/version records (Q13=A) and credential records remain logically distinct even if held in the same database.

## Rejected alternatives

- A dedicated external Secrets Store or Vault for every owner-created MCP credential.
- Plaintext credentials in D1 or embedding them in workflow definitions.

## Consequences

Use authenticated encryption and avoid recording plaintext, full tokens, secret-bearing errors, or decrypted values in workflow definitions, run histories or logs. These are necessary consequences of secure credential persistence, not an approved specific cryptographic implementation. Round 5 **Q30=A** establishes that rotating target credentials without changing the target or granted operation scope does **not** require republishing a Workflow; once credentials/grants are revoked, the system must prohibit subsequent calls using revoked authorization. Encryption envelope and associated identity, key rotation, recovery/backup, credential revision selection, in-flight already-dispatched calls, expiry, revocation propagation, and cross-target isolation mechanics remain **open**. **Q22=A** separately confirms compatibility with validated current and recent Streamable HTTP protocol versions; exact version negotiation, fallback and conformance tests remain unresolved and are recorded in the design log and existing MCP-boundaries ADR.

Design only: no provisioning/rotation of a real secret, schema migration, implementation, merge, deployment or Tickets.
