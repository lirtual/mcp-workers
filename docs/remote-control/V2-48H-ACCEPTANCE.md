# Remote Control v2 — T11 #57 single-device 48h acceptance

**State (2026-10-17): scope agreed, test not started or passed.** Existing isolated Preview Worker and the owner's independently paired WSL2 test Agent are the intended test environment. Parent #46 and Draft PR #58 stay release-blocked until objective evidence and a separate rollout decision. The v1 production Worker/Agent/Tunnel are out of scope.

## Scope and permissions

- **One** currently approved, disposable Linux/WSL2 test Agent, **48 hours of elapsed time**, on existing `remote-control-v2-preview` (not production v1). Do not create extra devices, Workers, CI workflows or secrets.
- The approved test device currently has ID `4b61c8f9-dddb-4023-a5eb-8607e1300749`, label `rc-v2-receipt-test`; confirm that ID and its current state again at start. Record Worker version and DO namespace at start/end.
- The existing real human-entered local 12-character terminal confirmation, device revocation/re-pair, Receipt and safety tests under #47/#50/#53/#54 are reusable evidence. No need to repeat destructive revoke or Shell mutation in the soak.
- This plan alone **does not start** any long-running hosted test or authorize deploying, changing Cloudflare secrets, reconfiguring production v1, or replacing its Agent.

## Before starting

1. Record UTC `start_utc`, planned `end_utc >= start+48h`, current preview version, test device ID and independent production v1 health. A live, signed WSS connection must be online before observation begins.
2. Collect an **account-wide** Cloudflare usage baseline, including other DO consumers (especially IMA). Confirm actual plan limits with Cloudflare docs at the time of testing: [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), and [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). Historical quotas in ADR-0014 are examples, not an entitlement guarantee.
3. Only the isolated WSL2 test instance may be restarted for a controlled reconnect. Do not stop or modify v1 or other devices.

## 48-hour observation

- Record an hourly status sample at minimum, including both endpoints (at least **49 samples** for an exact 48-hour window), with actual UTC timestamps. A brief offline interval may be recorded as `online_device_ids: []`; never mark it online or present sampled status as proof of uninterrupted connectivity. Record connection/close/reconnect events with durations separately.
- Include extended idle periods and low-frequency explicit-device read-only wake requests, one controlled reconnect, and evidence that offline requests fail closed with no queued replay. Reuse already reviewed mutation/Receipt safety tests instead of submitting new ambiguous writes.
- A WebSocket remaining connected **does not prove** Durable Object Hibernation. Require independently verifiable Cloudflare analytics and credible idle-duration/GB-s comparison supporting real sleep and wake. Note unknown or unavailable telemetry explicitly.
- Record Cloudflare account-wide Workers requests, DO billable requests, GB-s, SQLite rows read/written and storage for **each UTC calendar day intersecting the interval**, including partial first/last days; include other DOs such as IMA. Compare contemporaneous Free plan limits and retain conservative reserve. Never invent unavailable metrics.
- Revalidate normal production v1 health at the end, list any anomalies, and write the rollback plan before release review.

## Offline evidence validator

Create a local **sanitized** JSON report without private keys, Bearer tokens, pairing codes, plaintext command output or user-specific host secrets:

- `environment: "nonproduction"`; `start_utc`, `end_utc` ISO UTC at least 48 hours apart; `device_ids` containing **exactly one UUID**.
- `hourly_samples` covering start and end with maximum 60-minute gap, each `{ "at_utc": "...Z", "online_device_ids": ["<device-id>"] }` or `online_device_ids: []` during a documented disconnection; start and end should be online.
- `daily_account_usage` has one row per UTC calendar date touched, `source_ref`, `includes_other_durable_objects:true`, numeric `workers_requests`, `do_requests`, `do_gb_seconds`, `sqlite_rows_read`, `sqlite_rows_written`, `sqlite_storage_bytes`. Keep source references for independent verification.
- `evidence_refs`: `human_confirmation`, `do_hibernation`, `idle_duration_comparison`, `reconnect_epoch`, `offline_denial`, `revocation`, `unknown_receipt`, `v1_isolation`, pointing to safe review evidence.

Run:

```bash
node apps/remote-control-agent/scripts/check-v2-soak-evidence.mjs /path/to/sanitized-evidence.json
```

Exit 0 means **only** `ready_for_manual_review`, not PASS. Incomplete evidence, quota headroom below 20%, or an unavailable required metric fails the structural gate and needs a transparent manual decision; synthetic fixture data is never operational evidence.

## Release decision

If actual Hibernation evidence, Free headroom, real owner control or v1 independence is absent, mark **release-blocked** and keep #57 open. #57 closure, if approved after manual review, still does not auto-merge PR #58, deploy production, replace the v1 Agent, or authorize a Cloudflare configuration change. The v2 product retains multi-device routing despite this single-device endurance test.
