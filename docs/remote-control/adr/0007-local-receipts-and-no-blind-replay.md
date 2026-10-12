# ADR-0007 — Minimal durable local receipts and no blind replay

Status: accepted. Date: 2026-10-12. Decision input: Round 2 G3=A.

## Context

Remote MCP calls can time out, disconnect or lose their replies **after** a file write or process launch has reached the Linux executor. Retrying such calls blindly can duplicate changes or start multiple processes. The vendor's hosted Remote Desktop Commander uses its own Supabase-backed remote call statuses and recovery machinery; our single-device VPC deployment does not need to copy that cloud architecture.

## Decision

- Give each state-changing operation, including process launch, a stable **operation ID**; the device is authoritative for execution status.
- Persist a **minimal durable local receipt before dispatching the side effect**. A repeated call with the same operation ID must not dispatch a second side effect merely because a network response was lost.
- Keep local status sufficient to distinguish not-started, started/running, completed, failed and **unknown outcome**. On timeout, transport loss or crash when effects cannot be established, report `unknown` or allow a status query; **never automatically replay an ambiguous mutation**.
- Automatic retry is restricted to operations proven not to have started, or separately proven idempotent read-only operations. Do not promise exactly-once effects; a crash between execution and receipt update may leave an unknown result.
- Do not introduce a cloud queue, distributed lock service, DO, D1 or R2 solely to manage these single-device receipts. Data necessary for session status remains local.

## Consequences and trade-offs

- Positive: avoids accidental duplicate launches/writes after device, Tunnel or Worker outages.
- Positive: a single local authority limits distributed state and infrastructure cost.
- Cost: the device needs minimal persistent status, deduplication and bounded cleanup/recovery logic; it cannot infer unknown effects with certainty.
- Pending: receipt storage/retention, operation ID lifecycle, process session recovery, output pagination, stop/cancel and credential revocation semantics.
- Sensitive tool payloads, raw stdout and file contents are not required for the minimal receipt and should not be logged by default.

## Rejected option

Stateless best-effort response and retries without persistent operation identity were rejected because side-effecting operations would be unreconcilable after interrupted network delivery.
