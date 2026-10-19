# Remote Control v2 — #57 production 48-hour observation

**State: OPEN, not passed (2026-10-19).** This is a post-release observation of the **single already paired production Agent**, not a gate for another deployment or a repeat of accepted pairing/receipt tests. The original Preview Worker, its DO, and v1/VPC deployment were deleted at the operator's request. Previous Preview/v1 instructions and evidence in GitHub #57 are historical only; do not recreate their infrastructure.

## Immutable scope and baseline

- Current production Worker: `remote-control-mcp-worker`. Trusted install origin / Custom Domain: `https://rca.lirtual.dpdns.org`. **Keep the existing `rca.lirtual.dpdns.org/*` Worker Route unchanged as expressly requested.** No Worker/DNS/route cleanup, new deployment, secrets or timer is authorized by this document.
- Existing isolated production SQLite DO: `DEVICE_COORDINATOR` (`d2722b2151fc4b579c2b8c9c0ba6eb0b`); currently deployed version: `629ef906-a27e-47c4-9516-d79568281099` (2026-10-19 14:23:24 UTC). Confirm these values when evaluating an observation window; a later deploy or device replacement needs its own clearly marked window.
- Single existing permanent Agent: `RAY-WORKSPACE`, `af666663-b30c-4b3d-ad85-c8047dc3516b`. Real Portal MCP `pairing_lookup` → explicit `pairing_approve` → signed WSS online → `stat_file` and `read_file` for `/etc/os-release` (Ubuntu 24.04.3 LTS) **already passed** on 2026-10-19. Reuse that evidence; do not re-pair, revoke, read again for the sake of a checklist, or enable Shell/write.
- Cloudflare and MCP read-only checkpoint at `2026-10-19T14:47:02Z`: device online; same deployment version; 4 account DO namespaces (Remote Control, IMA, EdgeSSH and SSH). **This is a checkpoint, not proof of the start of a continuous 48-hour window.**

## Accepted low-disruption method

1. Observe **48 real elapsed hours** with exactly this device and deployment. Prefer existing WSL2 user-journal/systemd records, Agent reconnect/error timestamps, current Cloudflare telemetry and ordinary user activity. Record UTC start/end and source references. If the Linux distro stops, record actual offline intervals; a running systemd user service does **not** keep WSL2 running.
2. Keep evidence of idle → actual DO hibernation/wake and a normal targeted read, plus any naturally occurring recoverable disconnect/reconnect. **Do not cause network isolation, SIGSTOP, revocation, Shell mutation or extra pairing to fill a checkbox.** Prior #52/#53/#54/#97 security/receipt/recovery evidence remains valid for the behavior it actually tested, not as a substitute for this production window.
3. A `list_devices=online` snapshot or an aggregate DO hibernation-class metric by itself does **not** demonstrate uninterrupted connectivity or exactly timed eviction/resume. Correlate the same device/version with timestamps; explicitly flag gaps or unsupported interpretations.
4. Collect official UTC daily **account-wide** Workers requests, DO requests/duration GB-s, SQLite rows read/written **and stored bytes**, including the other existing DO namespaces, especially IMA, for each UTC day crossed. Note incomplete days, GraphQL sampling/rate limits and unavailable measures, never fill gaps with zero. Compare with published plan limits, leaving a conservative reserve; this is not a billable-usage claim from partial Analytics alone.
5. Record the final device/DO state and issues. Close #57 only after manual review determines the 48h stability, hibernation/recovery and shared Free budget evidence sufficient; then close parent #46 separately. **Do not retroactively infer 48h from prior Preview or one-off online reads.**

## Evidence and tooling caveat

- The historical validator lives in the **separate** `lirtual/remote-control-agent` repository at `apps/remote-control-agent/scripts/check-v2-soak-evidence.mjs`, not under this repository's `apps/` tree.
- Its current schema is **nonproduction-only**, hard-requires 49+ samples with gaps at most 60 minutes and `v1_isolation`, and can only report `ready_for_manual_review` even when its structure passes. As written, it **cannot** be applied honestly to this new production-only state or sparse passive observations. Do not fabricate hourly records or call a validator failure proof that production failed.
- If an automated completeness check becomes necessary, review a small schema update within existing #57 against genuine available logs, without loosening the requirement of 48 real hours and independent evidence. No new daemon, cron, ChatGPT task or Worker should be created by default.

## Current measured usage checkpoint — partial, not final

- At UTC ~14:40 on 2026-10-19, a read-only Cloudflare GraphQL query returned partial-day **3,704 account Workers requests** across reported scripts (including the since-deleted Preview), **90 DO requests**, and **16.727492736 GB-s** from the queried DO datasets.
- The `durableObjectsStorageGroups` query returned no rows; no current `storedBytes` is established. A later detailed query hit Cloudflare's five-minute GraphQL budget limiter. Treat this as a data availability gap, not zero storage and not a failure of the Worker.
- Official references: [Durable Object metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/), [pricing and limits](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

**Next gate:** collect authentic 48-hour time coverage and available account-wide storage/usage evidence during normal operation. Keep #57 OPEN until that review.
