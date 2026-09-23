# ADR 0002 — Local operation/session reconciliation and bounded transfer

Status: **Accepted product/lifecycle requirements (Q5, Q7, Q11, Q12, Q15, Q18–Q21; 2026-09-23); NOT an approved implementation or transport choice.** Research branch only; [historical ADR](https://github.com/lirtual/mcp-workers/blob/prototype/remote-desktop-vpc-178/.scratch/remote-desktop-vpc/docs/adr/0002-local-session-reconciliation-and-bounded-transfer.md) remains intact. Previous initiative #170 and PR #177/#179 remain closed/unmerged. See [CONTEXT](../CONTEXT.md) and [decision log](../decision-log.md).

## Context

Workers requests and VPC/Tunnel connections may fail even if a local command has started or finished; a timeout does not prove cancellation. The initial device is one Linux/WSL2 executor. Existing CI only exercises isolated fixed-root read-only transport; it does not verify live hosting or any privileged tools.

## Decision

- **Authoritative local state (Q5=A; Q11=A; Q15=A):** Maintain stable device operation and session IDs and queued/running/completed/failed/unknown states. Local registry owns process identities and bounded output. After reconnection, query status; never automatically replay an ambiguous Shell command, file write or other side effect. Do not introduce DO/D1/Queue as mandatory session storage without measured need.
- **Interactive Shell (Q18=A):** A new arbitrary Shell launch requires its own local approval. Subsequent command-affecting stdin requires separate approval unless a locally approved, specifically scoped and time-limited session grant covers it. Enforce independently of upstream `start_process` admission.
- **Revocation and stopping (Q19=A):** Revoke denies new dispatch and interactive stdin immediately; already-running *managed* processes continue until a separate explicit local stop. Network disconnect is not an automatic kill. Do not claim arbitrary host PIDs can be stopped or that detached children are automatically terminated. Explicit stop permissions must be checked.
- **Approval expiry (Q20=A):** Pending approval has bounded device-side lifetime. Bind to device, exact operation hash and one-shot nonce with expiry; unavailable/offline/expired approvals fail closed. A late approval must not execute a stale operation.
- **File and output bounds (Q12=A):** Small bounded control messages, paginated log retrieval and quota-controlled chunked file transfers with per-chunk integrity checks and explicit completion. Keep secrets out of default logs. Exact byte limits, deadlines and checksums remain to be measured and specified.
- **Audit (Q7=A; Q21=A):** Retain locally only bounded metadata (IDs/hashes, tool category, consent decision, timestamps, state and sanitized error); configurable default proposal 7 days. Never upload full stdout, file payload or credential material to cloud by default. Operation receipts necessary to reconcile are retained within an explicitly defined window; the precise receipt/audit expiry interaction must be specified.
- **Test entry (Q23=A):** Real private transport probe must use separately authorized nonpublic Worker-to-Worker Service Binding or equivalent authenticated ingress, not a public unauthenticated endpoint. Observe hosted private VPC and real device independently from old mocked CI.

## Consequences

- An operation may return an ID before completion; later queries read local state. Ambiguous outcomes are surfaced as unknown instead of being reissued.
- Revocation cannot retroactively undo already-running side effects and does not implicitly terminate processes. Stopping an existing managed process is a distinct user action.
- Stateful local receipts survive network disconnect to the extent the local disk/process registry survives. Durable storage/cleanup and ID collision handling need testing.
- Client read/write permissions are separate from this protocol; personal ChatGPT access cannot be inferred from server functionality.

## Alternatives rejected

Blind resend on reconnect; kill all processes on disconnect/revocation; perpetual stdin access after one approved launch; indefinite pending approvals; default full stdout/content cloud audit; mandatory DO/D1/R2 for a single device without measurements.

## Open evidence gates

Exact upstream session tools and PID ownership semantics; approval replay/expiry races; restart/crash/unknown behavior; byte, TTL, audit retention and chunk-integrity budgets; hosted VPC Tunnel/Worker evidence; compatible client and ChatGPT entitlement. Keep historical prototypes read-only; no merge, deployment or privileged tool enablement from this ADR.
