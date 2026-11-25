# ADR-0016: Local receipts and bounded commands

External mutations must bind to a stable operation identity before dispatch. The native Agent records a local receipt of that intent and returns the existing receipt on repeated queries. A changed intent with the same ID fails. A lost acknowledgment, timeout, Agent restart or unknown result is **not** permission to redispatch.

File operations, Shell and Agent-owned managed sessions use explicit resource, input/output and execution bounds. The Agent may stop only a process whose ownership it can still verify; stopping the connection or acknowledging cancellation is not proof that a remote child or external GitHub Job is terminated.

If receipt admission fails, reject new effects. Preserve original unknown/indeterminate records and device identity across upgrades; neither storage corruption nor a newer build authorizes deleting uncertainty, reconstructing side effects or resetting operation IDs. Keep receipt data minimal and do not persist credentials or unbounded command output.

Implementation authority is the current Agent and Worker source, protocol tests and the [Remote Control context](../CONTEXT.md). This architectural record does not authorize production writes, device changes or a release.


## 2026-11-25: accepted clarification — upgrade admission (#1035)

[Spec #1035](https://github.com/lirtual/mcp-workers/issues/1035): reject upgrade admission on unisolated execution risk, unconfirmed process termination or unsafe receipt storage/continuity. A historical Unknown alone is not a permanent blocker when execution risk is independently proven isolated and receipt continuity safe. Never erase, rewrite as success, replay or infer the original outcome to permit upgrade. Reuse existing executor/receipt boundaries and change them only on evidence of a gap.

Detached dispatch receipt is distinct from final lifecycle result. Establish completion/recovery using existing transaction evidence and independently observed version, identity, signed WSS and actual service availability. No new receipt system. Accepted design, not delivered behavior or implementation/production authorization.
