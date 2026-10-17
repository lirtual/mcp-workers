# ADR-0004 — Unmodified EdgeSSH boundary and fourth-round reliability policies

**Status:** Q17=A–Q20=A and Q21 (no EdgeSSH changes) accepted. Prior Q22 conflict is **resolved by Q22=B in [ADR-0005](./0005-independent-mcp-ssh-shared-edgessh-credentials.md)**. Final sign-off for `to-spec` and implementation remains outstanding.
Applies to future EdgeSSH-related MCP in `mcp-workers`; no runtime/secret/storage/production change is authorized.

Related: [ADR-0001](./0001-edgessh-mcp-cross-repo-boundary.md), [ADR-0003](./0003-bounded-live-sessions-and-authoritative-admission.md), [Grilling interview](../DESIGN-INTERVIEW.md).

## New factual constraint

`lirtual/EdgeSSH` is a fork of `aozorae/EdgeSSH`, not an upstream application the operator maintains. The operator explicitly declines EdgeSSH source modifications. This means no new private RPC method, no deployment/configuration alteration, no database migration inside EdgeSSH, and no dependence on downstream EdgeSSH fixes.

Current EdgeSSH code exposes interactive browser-oriented `/api/ssh`, `/api/sftp` and `/api/processes` over WebSocket, plus an authenticated host list and a browser `/api/hosts/:id/credentials` route returning plaintext SSH credentials. Authentication is GitHub login cookie or Access JWT; the service has **no existing execution-only named RPC/Service Binding entrypoint** for headless remote commands and no MCP operation admission/receipt contract. Merely adding a Service Binding from an external Worker cannot conjure up methods the target does not implement. Reusing a browser session/cookie as an unattended secret or exporting credentials through that browser API is not the previously chosen Q3 trust boundary.

## Accepted product decisions

- **Q17=A — Receipt retention:** Known terminal results have a normal 30-day retention window. Minimal unresolved `unknown` non-replay markers do not expire merely due to age and require deliberate reconciliation; retain identity/digest/status only, not raw sensitive parameters/output.
- **Q18=A — Honest manual reconciliation:** No retry/repair/re-execution of an uncertain side effect automatically. Look up the prior operation ID, inspect the remote state, then create a distinct new operation ID for any deliberate new action; acknowledgement is not permission to repeat the old ID.
- **Q19=A — Fail-closed receipt admission with narrow stop:** When receipts cannot be durably admitted, reject all new effectful operations and interactive input. Allow only authenticated best-effort stop/close of a demonstrably currently owned live managed session as an exceptional safety operation; do not turn this into receipt-free remote shell, arbitrary PID kill or blind claim of successful termination.
- **Q20=A — Token rotation / revocation:** Newly incoming calls require the current dedicated MCP Bearer and old credentials fail immediately. Rotation is **not** a promise of immediate remote process/session termination; bounded session lifetime and authorized best-effort stops are the chosen first-release behavior.
- **Q21 — Corrected operator constraint (overrides old A/B):** Do **not change EdgeSSH**. It stays an independently operated fork. Code, runtime bindings, secrets, schema, and deployment changes for the companion belong exclusively to `mcp-workers`. The earlier additive-EdgeSSH-RPC-first sequence is withdrawn, not accepted.

These policies are still required, and under Q22=B the independently deployed MCP Worker must enforce them at its own SSH execution boundary. This records design, **not authorization to configure secrets/DB bindings or deploy**.

## Resolved historical conflict: Q22=B expressly changes Q3 and Q14

**Q3=A** requires that only EdgeSSH decrypt saved SSH credentials and execute commands. **Q14=A** requires EdgeSSH to atomically claim and record MCP operation IDs before SSH dispatch. The now-unchangeable EdgeSSH code provides neither a suitable internal execute service nor an MCP receipt admission hook. Hence **Q2=B (arbitrary commands/SFTP writes), Q6=B (managed sessions), Q21 (unmodified EdgeSSH), Q3=A and Q14=A cannot all be delivered together with the current interfaces**.

**Decision (2026-10-17): Q22=B accepted**. The MCP Worker itself will decrypt EdgeSSH's encrypted host records using its own copy of the same root `ENCRYPTION_KEY`, and will independently execute SSH and own its durable operation receipts. **This expressly supersedes Q3=A and Q14=A; it does not edit EdgeSSH.** Refer to [ADR-0005](./0005-independent-mcp-ssh-shared-edgessh-credentials.md). Final operator consent before `to-spec` is still pending.

### Q22 alternatives — historical choice record (B SELECTED; A/C rejected)

**A (recommended for security/isolation): Independently managed MCP SSH connections.** Keep EdgeSSH untouched; `mcp-workers` owns its own SSH connection credentials/config (entered/imported deliberately, not silently synced), authenticated SSH protocol, managed sessions and receipts using the MCP worker's own storage. May reuse code from the Apache-2.0 EdgeSSH project under required license/notice conditions, but this creates a separate maintained SSH execution copy and no automatic credential synchronization. Explicitly supersedes Q3=A and Q14=A; the "all hosts" intent applies to hosts onboarded to the MCP companion, not magically all EdgeSSH records.

**B (SELECTED, SECURITY-SENSITIVE): Shared EdgeSSH D1 + copied encryption key.** Keep EdgeSSH code/production behavior untouched; configure the new `mcp-workers` app with a binding to **the same D1 database** and a copy of `ENCRYPTION_KEY`, decrypt records on the MCP side, and execute SSH using an independent implementation. Read-only consumption of host records must be strictly enforced, including schema compatibility and fingerprint checks. This offers automatic host/credential reuse but explicitly reverses Q3=A, extends exposure of all SSH secrets to another Worker, couples the project to the upstream encrypted record schema, and moves Q14's receipt authority to the MCP execution side. Avoid forwarding browser credentials endpoint or storing decrypted keys in logs/KV. *Q22=B is architecturally accepted, but no credential access, secret copying, binding provisioning or deployment is authorized in the documentation-only phase.*

**C (preserve Q3/A and Q14/A but defer functionality):** Do not implement an unattended SSH/SFTP-executing MCP until an upstream-maintained execution-only interface exists, or requirements are changed. A metadata-only integration is not equivalent to the accepted Q2=B/Q6=B first-release scope.

An EdgeSSH browser-cookie bot, manual copying of cookies, browser WebSocket impersonation and using `/api/hosts/:id/credentials` as an MCP tool are not recommended shortcuts: they export credentials or depend on interactive user sessions without enforceable receipts.

## Consequences

- **Benefit of Q21:** zero fork divergence and upstream merge burden; EdgeSSH continues standalone.
- **Cost:** the previous elegant private RPC / EdgeSSH-secret-custodian plan is unimplementable as designed. Any actively executing MCP must either become a new SSH credential custodian (Q22=A/B) or wait for upstream support (Q22=C).
- **Safety gate:** do not build independent credential sync, duplicate database writes, private-key export, dedicated SSH Agent, a new global scheduler or automatic replay platform while Q22 is unanswered.
- **Current review:** Q22=B resolved the old contradiction and historical Q3/Q14 are expressly marked superseded. [The final security and overengineering review](../FINAL-ARCHITECTURE-REVIEW.md) records the shared root-key (including login-cookie signing derivation) and D1 Binding write-capability as irreducible risks. PR stays Draft until explicit final design sign-off; no code/production changes.
