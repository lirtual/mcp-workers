# EdgeSSH MCP — Grilling with Docs · Decision Record

Status: **Historical Q1–Q5 decision record; Q3 execution ownership is BLOCKED by the subsequently accepted no-EdgeSSH-modification constraint in [ADR-0004](./0004-unmodified-edgessh-and-reliability-policy.md). Final design not approved.**
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

### Q3=A: EdgeSSH-only credential custody and execution — **SUPERSEDED by Q22=B**
**Historical reasoning:** the original private-RPC proposal required EdgeSSH to keep the sole ability to decrypt credentials and run commands. **Current Q22=B expressly reverses that ownership choice:** an independently deployed MCP Worker holds its own copy of EdgeSSH's `ENCRYPTION_KEY`, reads the existing host catalog, decrypts credentials in its own runtime, and executes SSH. **Still forbidden:** returning plaintext credentials or keys in tool outputs/logs, using browser login cookies, or calling the browser credential-returning API. See [ADR-0005](./0005-independent-mcp-ssh-shared-edgessh-credentials.md).

### Q4=B: All saved hosts eligible
An authorized MCP caller can select **any** saved host without a per-host opt-in feature, allowlist or separate permissions database. This does not waive host-key identity verification, the requirement that the record contain usable credentials, or normal SSH account privileges. The power of the single MCP access token thus spans the whole workspace; this is an explicitly accepted expanded impact radius.

### Q5=A: Dedicated Portal Bearer
Reuse the repo's existing `portal-auth` static Bearer approach, using a **dedicated high-entropy MCP_ACCESS_TOKEN value** for EdgeSSH MCP distinct from other Workers. Do not introduce a direct-client OAuth provider in v1. Compatibility with other MCP clients remains conditional on their ability to provide the Bearer via the chosen Portal route.

## Consequences and considered alternatives

**Advantages**
- Browser EdgeSSH remains an independently usable product.
- **Historical only for the private-RPC candidate:** originally expected no credential/SSH implementation duplication. Under Q22=B, the host catalog is reused (not copied), but credential custody and SSH execution necessarily exist in MCP as well.
- **Historical:** a small private RPC was preferred, but the unmodified EdgeSSH fork has no such interface. Q22=B uses direct D1 reads and independent SSH instead.
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
- **Historical Q3=B**: encryption-key sharing was rejected in the first round, then **expressly accepted as Q22=B** after Q21 prohibited EdgeSSH source changes.
- Q4=A per-host opt-in
- Q5=B shared low-risk token, and Q5=C full OAuth
- New general-purpose remote-control agent, common SSH SDK, generic permission platform, persistent session orchestrator or additional credential database

## Subsequent resolution (Q22=B accepted; no additional architecture frontier)

The operator subsequently accepted Q6–Q10 ([ADR-0002](./0002-managed-ssh-sessions-and-operation-receipts.md)), Q11–Q16 ([ADR-0003](./0003-bounded-live-sessions-and-authoritative-admission.md)), Q17–Q21 ([ADR-0004](./0004-unmodified-edgessh-and-reliability-policy.md)) and ultimately **Q22=B** ([ADR-0005](./0005-independent-mcp-ssh-shared-edgessh-credentials.md)). Q3=A is no longer operative; all saved hosts, unique Bearer and same-account constraints still apply. The D1 binding is write-capable even when MCP application code only performs SELECT, and copied `ENCRYPTION_KEY` also relates to GitHub login signing. Draft SPEC.md has since been published; implementation remains separately gated by SPEC §12.

Q22=B is the accepted architectural choice; code and deployment authority remain separately gated by SPEC §12. See [DESIGN-INTERVIEW.md](../DESIGN-INTERVIEW.md).
