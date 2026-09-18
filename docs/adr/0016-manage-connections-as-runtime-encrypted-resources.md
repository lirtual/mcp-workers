# ADR 0016: Manage connections as runtime encrypted resources

- Original status: Accepted
- v0.1 disposition: SUPERSEDE
- v0.1 authority: `docs/workflow-mcp/v0.1-architecture-reduction.md`
- Date: 2026-09-17

## Context

A general workflow platform may accumulate many external connections over time. Treating each connection credential as a deployment-time environment secret makes the number of connections depend on platform binding limits and forces redeployment for routine operations such as adding, disabling, or rotating a connection. Storing plaintext credentials in workflow definitions or ordinary runtime records is unacceptable.

## Decision

Connection Registry entries are runtime-managed resources. Connection metadata and encrypted credential material are persisted in workflow runtime storage rather than represented as one deployment binding per external connection.

v0.1 protects connection credential material with authenticated encryption under a single platform-held root key and records key version information so future root-key rotation can be supported deliberately.

Workflow Definitions refer to Connections only through Connection References. They cannot contain raw external endpoints plus credentials as a substitute for the registry.

Adding, disabling, or rotating a Connection must not require redeploying the Workflow Worker.

v0.1 initially requires the MCP connection type, but the registry model must remain general enough for later HTTP, database, OAuth, GitHub, or other connection families.

## Consequences

### Positive

- Connection lifecycle is independent of deployment lifecycle.
- The platform needs only a small fixed number of deployment secrets rather than one secret per connection.
- Workflow definitions remain free of raw credentials.
- The same governance model can support future connection types.

### Negative

- The workflow service becomes responsible for secure encryption, decryption, key versioning, redaction, and credential lifecycle operations.
- Compromise of the root encryption key has broad impact and requires a clear rotation/re-encryption process.
- Runtime connection administration requires authenticated management APIs/tools.

## Rejected alternatives

- One Worker secret per connection: couples connection count and rotation to deployment configuration.
- Store credentials in plaintext runtime records: unacceptable disclosure risk.
- Let workflow YAML provide arbitrary MCP URLs and credentials: bypasses governance and widens SSRF/credential-exfiltration risk.
