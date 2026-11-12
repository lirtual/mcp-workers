# ADR-0016: Local receipts and bounded commands

External mutations must bind to a stable operation identity before dispatch. The native Agent records a local receipt of that intent and returns the existing receipt on repeated queries. A changed intent with the same ID fails. A lost acknowledgment, timeout, Agent restart or unknown result is **not** permission to redispatch.

File operations, Shell and Agent-owned managed sessions use explicit resource, input/output and execution bounds. The Agent may stop only a process whose ownership it can still verify; stopping the connection or acknowledging cancellation is not proof that a remote child or external GitHub Job is terminated.

If receipt admission fails, reject new effects. Preserve original unknown/indeterminate records and device identity across upgrades; neither storage corruption nor a newer build authorizes deleting uncertainty, reconstructing side effects or resetting operation IDs. Keep receipt data minimal and do not persist credentials or unbounded command output.

Implementation authority is the current Agent and Worker source, protocol tests and the [Remote Control context](../CONTEXT.md). This architectural record does not authorize production writes, device changes or a release.
