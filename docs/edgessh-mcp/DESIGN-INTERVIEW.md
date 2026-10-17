# EdgeSSH MCP — Grilling with Docs · Accepted decisions and final consensus gate

**Status: Q1–Q22 answered; operator invoked `to-spec`; [Draft SPEC.md](./SPEC.md) published. Implementation/production not approved.**
Date: 2026-10-17. Documentation-only Draft PR #81. **No EdgeSSH or production modification.**

## Current architectural authority

- [ADR-0005: Q22=B independent MCP execution and shared EdgeSSH credentials](./adr/0005-independent-mcp-ssh-shared-edgessh-credentials.md)
- [Final security and overengineering review](./FINAL-ARCHITECTURE-REVIEW.md)
- Historical decisions and their reasons remain in [ADR-0001](./adr/0001-edgessh-mcp-cross-repo-boundary.md), [ADR-0002](./adr/0002-managed-ssh-sessions-and-operation-receipts.md), [ADR-0003](./adr/0003-bounded-live-sessions-and-authoritative-admission.md), [ADR-0004](./adr/0004-unmodified-edgessh-and-reliability-policy.md).

## Recorded grilling outcomes

| Round | Decisions | Current outcome |
| --- | --- | --- |
| 1 | Q1=A Q2=B **Q3=A→superseded** Q4=B Q5=A | Same-account, arbitrary SSH/SFTP, all saved hosts, independently authenticated MCP |
| 2 | Q6=B Q7=A Q8=A Q9=B Q10=A | Managed interactive sessions and live jobs, human-pinned host keys, unattended access, durable receipts, text SFTP |
| 3 | Q11–Q13=A **Q14=A→superseded** Q15=A Q16=A | No replay on disconnect, verifiable session ownership, interactive-input dedup, finite capacity, explicit text edits |
| 4 | Q17–Q20=A Q21=no fork modification | 30-day terminal receipt retention, protected unknown markers, manual reconciliation, fail-closed admission with emergency stop, token rotation semantics, unchanged EdgeSSH |
| Last | **Q22=B accepted** | MCP reads shared EdgeSSH encrypted host catalog and copied root secret, independently owns SSH execution, session/receipt durability and deployment |

The two supersessions are **explicit changes**, not reinterpretations:

- **Q3/A is superseded:** previously EdgeSSH alone decrypted credentials/ran SSH. Now both EdgeSSH and independent MCP hold the root key; MCP decrypts host credentials **only in its runtime** to establish its own SSH sessions. EdgeSSH remains owner of the host records and unchanged. MCP never exports the secrets as tools or logs.
- **Q14/A is superseded:** previously EdgeSSH would atomically admit MCP operation IDs. Now the **MCP-owned** SSH/DO execution boundary claims operation IDs before dispatch and keeps authoritative receipts. No EdgeSSH API, D1 migration or Worker RPC is needed.

## Final minimum architecture

```text
AI / MCP Portal
     |
     | dedicated MCP Bearer
     v
mcp-workers/apps/ssh-mcp-worker    (one independently deployed Worker)
     |                |
     |                +-- MCP-owned SQLite DO: session owner + atomic receipts
     |
     +-- SELECT host rows --> existing EdgeSSH D1
     |                         (no writes by the application)
     +-- copied secret --> decrypt fresh host record in memory
     |
     +-- Workers SSH transport --> public SSH host
           + verified pinned host key
           + bounded exec / PTY / SFTP text
     
UNCHANGED EdgeSSH Worker --> same existing D1
```

### Source compatibility facts verified

- `lirtual/EdgeSSH` is a fork of `aozorae/EdgeSSH`, Apache-2.0; no EdgeSSH code/deployment changes authorized.
- `hosts` stores `id,account_id,encrypted_payload,updated_at`. `workspace_state` supplies the canonical account ID.
- `src/accounts/crypto.ts` decrypts `v1.` AES-GCM ciphertext with AAD `edgessh:v1:${accountId}:${hostId}`, using the 32-byte Base64 `ENCRYPTION_KEY`; the host payload includes credentials, `fingerprint`, and `initialCommand`. **Do not run `initialCommand` automatically.**
- `src/accounts/github-auth.ts` derives GitHub flow/session Cookie signing keys from this same encryption root using HKDF; shared root-key compromise has login-auth implications when GitHub mode is in use.
- D1 Binding offers write-capable SQL methods: **fixed SELECT-only code cannot enforce database-level read-only privilege.** This is an explicitly documented accepted residual risk, not solved by names like `READONLY_DB`.
- Current EdgeSSH SSH transport is browser-WebSocket oriented, not a headless API. The new MCP must prove compatible SSH/PTY/SFTP feasibility within its own runtime, ideally adapting licensed reusable primitives instead of duplicating the protocol.

## Security invariants and hard gates

- All Saved Hosts are visible/eligible, but a missing/mismatched human-pinned host-key fingerprint must **fail closed before credentials are sent**.
- Preserve public target/DNS rebinding/blocked port protections, validate fresh saved host ID and encrypted payload; never allow caller-provided arbitrary TCP destinations.
- Never expose the saved connection password/private key or root key as tool fields, logs, receipts or errors. **Arbitrary command output or file reads can contain other remote secrets** and cannot promise automatic redaction. Copy key only through deliberate later secret provisioning, **not in this Draft PR**.
- Do not invent an EdgeSSH execution RPC, call the browser credential-returning endpoint, replay browser cookies, alter EdgeSSH schema or silently synchronize a new database.
- One MCP app may own its SQLite-backed DO for bounded live sessions and receipts; no extra standalone Worker/database/queue/agent/scheduler.
- Receipt admission *before* SSH dispatch with unique IDs/digests; unknown effects do not auto-replay. Always keep clear distinction between accepted intent, SSH delivery, exit status and confirmed effects.
- Fail-closed missing/rotated secrets, incompatible schema, unavailable receipt storage, absent pinned host-key or SSH transport instability.
- Independently disable/rollback MCP while preserving unknown receipts, without touching the EdgeSSH fork.

## Final deep audit — conclusion

**The previous unmodified-fork Q21 and EdgeSSH-only Q3/Q14 architecture contradiction is resolved by Q22=B.** A single MCP Worker with its own session/receipt DO and a direct, logically SELECT-only binding to existing EdgeSSH D1 is the minimum coherent **auto-reuse** design that satisfies the desired first-release scope.

**Not equivalent to least privilege:** the copied root `ENCRYPTION_KEY` exposes more than individual SSH credentials (including login key derivation), and D1 Binding includes write methods even if the code only reads. Extra layers would not erase those facts without abandoning Q22=B or changing EdgeSSH. Those are residual risks for explicit operator final sign-off.

**No additional grilling frontier remains.** Exact quotas, session API contracts, operation receipt schema, compatibility tests, credential provisioning runbooks, upstream update handling and rollback procedures belong in the later `to-spec`; they are not new scope choices. Before writing production code, require an isolated feasibility proof for Workers SSH PTY/SFTP and safe AAD decryption fixtures. Reuse existing CI and add tests, not new infrastructure by default.

**Consent boundary updated:** The operator explicitly invoked `to-spec` to authorize drafting [SPEC.md](./SPEC.md) within PR #81. This does **not** authorize code changes, production secret/D1 access, real SSH tests, PR merge or deployment. The Spec requires separate review before tickets/implementation.
