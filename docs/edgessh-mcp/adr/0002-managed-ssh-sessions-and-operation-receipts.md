# ADR-0002 — Managed SSH sessions, trusted hosts, unattended operations and durable receipts

Status: **Round 2 operator decisions accepted on 2026-10-17; Round 3 boundaries recorded in [ADR-0003](./0003-bounded-live-sessions-and-authoritative-admission.md). Further retention/failure/rollout policy remains open.**
Scope: prospective EdgeSSH-owned SSH execution / optional MCP adapter. Design decision only, no code or production authorization.
Related: [ADR-0001](./0001-edgessh-mcp-cross-repo-boundary.md), [interview](../DESIGN-INTERVIEW.md).

## Context

ADR-0001 recorded same-account deployment, a separately deployed MCP adapter, EdgeSSH's exclusive custody of SSH credentials, all Saved Hosts eligible, and a dedicated Portal Bearer. The operator selected a wide tool scope from the outset, including arbitrary commands and SFTP mutation.

EdgeSSH's current `SSHSession` is browser-WebSocket-centric and uses a Durable Object for live SSH state. SSH `exec` is implemented for system/process probes and SFTP supports file operations but their present contracts do not provide a general, independently invoked managed Shell or receipt-protected request/response API. Reuse must be demonstrated without simulating a browser WebSocket and without duplicating SSH cryptography.

Q6 and Q9 were chosen because an AI caller needs Shell sessions and durable knowledge of requests across successive MCP calls or response loss. These capabilities must not be conflated with magically persistent TCP connections or exactly-once remote effects.

## Accepted decisions — Round 2

1. **Q6=B — Managed interactive SSH and background jobs from v1.** The product must expose long-lived, caller-addressable interactive Shell and background command workflows that can outlive a single MCP call, with status, input/output, stop and recovery **semantics**. This decision does not assert that the same SSH TCP connection, remote PTY or process will survive outages, and does not yet approve detached independent job supervision. The meanings of "persistent", "owned", "stop" and "recovery" require Round 3 choices.
2. **Q7=A — Human-confirmed SSH Host Identity.** MCP operations may authenticate to a saved host only after the human has confirmed the pinned SSH host fingerprint via EdgeSSH. If absent, unrecognized or changed, fail closed; neither the model nor the MCP adapter may accept or overwrite SSH fingerprints automatically. All hosts are eligible under Q4=B but not all are necessarily trusted or reachable.
3. **Q8=A — Unattended operation authorization.** Valid EdgeSSH MCP Bearer authorization permits commands and file mutations without a *new EdgeSSH-side human approval for every operation*. This is a deliberate broad permission, not read-only and not a sandbox. The actual SSH login account's OS privileges remain the execution authority. This decision does not waive input bounds, identity checks, durable admission, or denial on invalid authentication.
4. **Q9=B — Durable receipts and deduplication.** First-release state-changing operations require durable records and duplicate-request protection. A receipt must distinguish definitive non-dispatch from success/failure after execution, and from `unknown` when effects might have happened. It must not turn a connection loss into a safe automatic retry, or claim exactly-once remote effects. Storage and interactive-input coverage remain unsettled.
5. **Q10=A — Bounded text SFTP, not general binary transfer.** MCP-side SFTP supports text-oriented reads/writes plus ordinary directory and filename operations such as create, rename, delete and mkdir. Do not add bulk binary transfer, resumable upload, a file-blob service or a second streaming protocol in v1. The browser's 64 MiB upload limit is not the MCP's limit; determine the smaller MCP-specific bound later.

## Security and operation invariants

- **No SSH credential export:** only EdgeSSH decrypts and uses credentials, not the MCP Worker. Never forward the existing credential-returning browser endpoint as a tool.
- **No host-key auto-approval:** a new or mismatched fingerprint blocks even an otherwise authenticated unattended command until a human verifies it.
- **No hidden per-host restrictions:** Q4=B explicitly allows all Saved Hosts. Host-key checks and stored SSH account privileges remain enforceable.
- **No guarantee of a surviving TCP session:** Cloudflare [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) and [TCP socket behavior](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) do not justify a guaranteed always-live SSH session. A durable session ID is not a durable TCP connection. A remotely detached process might outlive its connection without being controllable.
- **No automatic replay of uncertain side effects:** a durable admitted/in-flight record is the necessary local guard, not proof of what the remote system applied. Resubmitting the same operation ID cannot bypass the guard; using a different ID is a new deliberate action, not guaranteed safe.
- **Shell input is dangerous:** characters sent to an interactive PTY can represent arbitrary mutations; the receipt and session policies must address it explicitly in Round 3.
- **No pretend terminal completion:** command exit codes, SSH request acknowledgement, session closure and confirmed effects are different facts. Do not invent an exit status for an unobservable remote process.
- **Controlled costs and capacity:** persistent interactive sessions need finite resource bounds; precise policy remains under review.
- **Independently operable EdgeSSH:** any MCP adapter absence, failed binding or incomplete integration may not disable the browser WebSSH product.

## Consequences and trade-offs

**Positive:** interactive AI debugging and sustained remote command workflows become possible without installing Agent software on SSH targets; durable receipts reduce accidental repeat submission; first-release text SFTP covers high-value edits without a binary data-transfer platform.

**Negative:** broader attack radius (all saved hosts, unattended operations), higher SSH lifecycle complexity than one-shot `exec`, additional receipt durability constraints, and ambiguous remote process outcomes during network failure. Cloudflare runtime resets can end live sessions; a receipt protects against blind replay, not remote filesystem rollback. Host-key pre-enrollment adds an intentional human prerequisite.

**Explicitly rejected by these decisions:** one-shot-only/no managed sessions (Q6=A), unattended first-use/changed-fingerprint auto-trust (Q7=B), per-tool human approval workflow (Q8=B), no durable receipt implementation (Q9=A), first-release binary streaming/bulk transfer (Q10=B). Do not sneak these back as silent scope reductions or expansions.

## Subsequent decisions — Round 3

The operator accepted **Q11=A–Q16=A** in [ADR-0003](./0003-bounded-live-sessions-and-authoritative-admission.md): lost connections do not trigger automatic re-execution, only provably session-owned live jobs may be stopped, interactive input has receipt deduplication, EdgeSSH owns durable admission in its existing storage, sessions/output have finite limits, and MCP SFTP writes are explicit bounded UTF-8 operations.

**Still open:** receipt retention and protected unknown outcomes, reconciliation authority, exceptional owner-scoped stop if receipt persistence fails, MCP token revocation effect on live sessions, and independent code/schema deployment and rollback. Q1–Q16 alone never authorized live rollout.

No code changes, database migrations, Cloudflare bindings, new deployments or production SSH actions are authorized by this ADR.
