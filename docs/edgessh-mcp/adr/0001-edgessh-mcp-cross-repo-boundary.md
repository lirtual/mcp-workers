# EdgeSSH MCP — Grilling with Docs · Decision Record

Status: **Round 1 decisions accepted by operator on 2026-10-17; final technical design NOT yet approved**.
Document-only change. No implementation, production change, secret provisioning, Portal registration, or release authorization.

## Context and verified baseline

- EdgeSSH is a self-hosted single-admin WebSSH workspace; SSH host records and credentials belong to EdgeSSH.
- Existing browser-facing SSH sessions depend on WebSocket-linked `SSHSession` + Durable Objects. The SSH transport provides an `exec` request primitive, but a general-purpose headless operation with bounded stdout/stderr, exit semantics, and cleanup has not yet been implemented.
- Existing SFTP supports listing, download, upload, rename and removal through browser-oriented sessions. Those operations must not be assumed to have an existing MCP-friendly request/response contract.
- `mcp-workers` maintains independent MCP apps and an established Portal-only Bearer ingress pattern.
- Cloudflare same-account Service Binding RPC can call a named entrypoint without a publicly accessible internal endpoint, but does not automatically convey human authorization.

## Accepted architectural decisions (Q1–Q5)

### Q1=A: Same-account scope only
The first version integrates EdgeSSH and its MCP adapter deployed inside one Cloudflare account. Cross-account federation or a public authenticated bridge is out of scope.

### Q2=B: Broad first-release SSH + SFTP scope
The intended first-release product provides caller-specified SSH command execution **and remote SFTP mutations**, not merely cached host metadata or fixed read-only diagnostics. This grants potentially destructive remote operation capability; it is not characterized as a read-only MCP. The precise command/session lifecycle, file operation formats and limits remain second-round questions, not implied defaults.

### Q3=A: EdgeSSH owns credentials and execution
The MCP adapter must **never** read the EdgeSSH D1 credential ciphertext directly, share `ENCRYPTION_KEY`, or return decrypted SSH passwords/private keys. EdgeSSH retrieves credentials and performs remote operations, returning bounded/sanitized results. Its existing browser credential-returning endpoint is not an MCP interface.

### Q4=B: All saved hosts eligible
An authorized MCP caller can select **any** saved host without a per-host opt-in feature, allowlist or separate permissions database. This does not waive host-key identity verification, the requirement that the record contain usable credentials, or normal SSH account privileges. The power of the single MCP access token thus spans the whole workspace; this is an explicitly accepted expanded impact radius.

### Q5=A: Dedicated Portal Bearer
Reuse the repo's existing `portal-auth` static Bearer approach, using a **dedicated high-entropy MCP_ACCESS_TOKEN value** for EdgeSSH MCP distinct from other Workers. Do not introduce a direct-client OAuth provider in v1. Compatibility with other MCP clients remains conditional on their ability to provide the Bearer via the chosen Portal route.

## Consequences and considered alternatives

**Advantages**
- Browser EdgeSSH remains an independently usable product.
- MCP code has its own deployment and repo lifecycle, without duplicating the SSH protocol, D1 host store, or credential custody.
- One self-hosted Cloudflare account and a small named RPC surface avoid an extra public credentials gateway.
- No per-host RBAC or second credential vault.

**Risks and costs**
- Q2=B + Q4=B means possession of the dedicated MCP token may allow high-impact commands and file modifications on *every* saved host under each host's stored SSH account privileges. A leaked token or malicious prompt may therefore cause cross-host damage.
- A same-account Service Binding alone authenticates caller workload identity/capability, not an individual administrator. The target Worker must enforce its own operation contract and reject credential-export methods.
- The current browser session model requires a real engineering seam for noninteractive SSH, not a simulation of browser WebSockets.
- Mandatory SSH host-key verification may block automation on untrusted/newly changed hosts; the appropriate enrollment UX remains open.
- The proposed universal host scope intentionally forgoes a per-host safety boundary.
- Portal Bearer interoperability is not the same as universal OAuth client compatibility.

**Rejected for this iteration**
- Q1=B cross-account public gateway
- Q2=A/C fixed read-only diagnostics or metadata-only product
- Q3=B duplicate storage or encryption key sharing
- Q4=A per-host opt-in
- Q5=B shared low-risk token, and Q5=C full OAuth
- New general-purpose remote-control agent, common SSH SDK, generic permission platform, persistent session orchestrator or additional credential database

## Unsettled decisions — next interview round

Per-operation consent vs unattended access, host fingerprint prerequisites, headless exec lifetime, file operation granularity/transfer bounds, and state-changing call timeout/retry reconciliation. These are **not** granted by Q1–Q5.

Do not create code, deploy, accept production risk, or mark the technical design complete until the operator confirms the final architecture. See [DESIGN-INTERVIEW.md](../DESIGN-INTERVIEW.md).
