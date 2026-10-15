# Remote Control v2 — T11 / #57 nonproduction acceptance gate

**Status (2026-10-15): isolated v2 preview deployed AND owner-provisioned Secret enabled.** Real device pairing, authorized-owner MCP tool calls, signed WSS, 72h soak and production migration have NOT started. PR #58 remains Draft/unmerged and v1 production is unchanged. Preview Worker active version after private Secret deployment: `6f434b75-3f33-423d-afdc-bdfac98d5e83` (100% preview), endpoint `https://remote-control-v2-preview.aiyaya.workers.dev`; independent SQLite DO namespace `remote-control-v2-preview_V2OwnerCoordinator`. Original production v1 remains on `554b36ad-ccbb-47c8-8067-0345a7f61613` (100%).

## Separate v2 preview rollout — authorization and isolation

The owner authorized a **separate nonproduction preview deployment and disposable test-device pairing/fault exercises** on 2026-10-15. This does NOT authorize changing production v1 Worker, Agent, Tunnel, secrets, or shutting down any existing non-test Windows/WSL machine. An actual human must still enter the confirmation challenge in the new Agent's own terminal.

The reviewed staging config is `apps/remote-control-mcp-worker/wrangler.v2-preview.jsonc`. It names `remote-control-v2-preview` (NOT `remote-control-mcp-worker`), binds `V2_OWNER` to a new SQLite-backed DO namespace, and has **no v1 VPC Service or REMOTE_CONTROL_DEVICE_TOKEN**. Setting `REMOTE_CONTROL_V2_PREVIEW_ONLY=true` disables Shell, file mutations and implicit v1 calls. If its own `MCP_ACCESS_TOKEN` is missing, all public preview routes—including Agent bootstrap—return 503. Invocation Logs remain disabled.

**Completed bootstrap (isolated no-secret deploy):** From reviewed commit `4a48f1b5d5ede1ddcd36c8054d479e1e5a991f6c`, Node 24.21.0 + Wrangler 4.151 verified the preview bundle and config. The normal config requires `MCP_ACCESS_TOKEN` and rejects first-time upload without it. Instead, the temporary-purpose, separately tested `wrangler.v2-preview-bootstrap.jsonc` differs only by omitting the secret *declaration*, while the Worker itself denies **all** preview HTTP routes when the secret is absent. Wrangler deployed this config and created the isolated SQLite DO, without any v1 VPC or credentials. Public checks confirmed `GET /`, `POST /mcp`, `POST /agent/pair/start`, and `POST /agent/session/challenge` all return **503**. Cloudflare secret-name listing returned empty; no credential was generated or shared.

**Owner-provisioned Secret verified (2026-10-15):** Cloudflare API revealed only its *name and type* (`MCP_ACCESS_TOKEN`, `secret_text`), never its value; preview still has `REMOTE_CONTROL_V2_PREVIEW_ONLY` and SQLite `V2_OWNER`, with **no v1 VPC binding**. Public negative-auth checks: unknown path **404**, `POST /mcp` without Bearer **401**, wrong Bearer **401**, untrusted Origin **403**, invalid Agent pairing request **400**. These do NOT prove a correct authenticated MCP call works. Use normal required-secret config for subsequent releases:

    pnpm --filter remote-control-mcp-worker exec wrangler deploy --config wrangler.v2-preview.jsonc

This preserves the same isolated Worker and DO namespace. The Secret was configured independently by the owner via Cloudflare dashboard; its value was not inspected or transmitted through the remote execution connector. **Next gate:** add a separate custom MCP connection in ChatGPT (where available), targeting `https://remote-control-v2-preview.aiyaya.workers.dev/mcp`, and enter the preview Bearer credential only in its private authentication UI, never in this chat or v1 plugin. Confirm authenticated initialize/tools/list and list_devices before enrolling only an approved disposable new Agent. Manual local-terminal code and challenge confirmation remain mandatory. No host is currently paired.

Next, using only authorized disposable test Linux/WSL2 Agents, complete fingerprint lookup, preparation and **manual local-terminal** confirmation; verify first read-only explicit-device call, then measure reconnect, epoch fencing, real DO Hibernation, account-wide quotas and unaffected production v1. Track exact deployed version and run timestamp. Do not mark the 72h gate complete from a dry run or mocked device statuses.
\n## Authorization and preflight (before real testing)

The owner must separately authorize a **nonproduction** Cloudflare v2 deployment and five designated test devices (real hosts or independently simulated Agent identities). Record the exact environment URL (never embed a credential), deployed Worker/version and DO namespace, shared Cloudflare account, five **distinct** approved Ed25519 identities, and who may stop/reboot test hosts. Do not reuse or reconfigure the existing v1 Worker/Tunnel/device token. Do not start `wsl.exe --terminate` or restart production services. The real ChatGPT client must show the immutable fingerprint and human owner must separately enter the challenge in the new Agent terminal; a pair of automatic tool calls is not sufficient.

Verify Cloudflare Workers and Durable Objects **Free** quotas immediately before the test against current official documentation; recorded baseline as of 2026-10-15 (not an entitlement guarantee):

| Account-wide daily metric | Free allowance | Conservative 80% evidence-review threshold |
| --- | ---: | ---: |
| Workers requests | 100,000 | 80,000 |
| DO billable requests | 100,000 | 80,000 |
| DO duration | 13,000 GB-s | 10,400 GB-s |
| SQLite DO rows read | 5,000,000 | 4,000,000 |
| SQLite DO rows written | 100,000 | 80,000 |
| DO stored data | 5 GB/account | 4 GB |

**Include the entire account**, not merely v2: especially other DO workloads such as IMA and existing Worker traffic. Check the account plan, billing semantics and quotas again at test time. Do not assume "five idle sockets" are free without proving DO can hibernate. Cloudflare says it can hibernate after no events and when no scheduled timers, unfinished requests/waitUntil or outgoing connections exist; its JavaScript heap is reset on wake. Constructor invocations are not sufficient proof on their own: compare *measured* idle billable GB-s, traffic and restart behavior to a non-hibernating baseline, and collect supporting Cloudflare analytics evidence.

References: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ ; https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ; https://developers.cloudflare.com/durable-objects/platform/pricing/ ; https://developers.cloudflare.com/workers/platform/limits/ .

## Minimal acceptance sequence

1. Record current **v1 production** health and Cloudflare account-wide 24h usage, without secrets. Confirm existing v1 routes and Tunnel unchanged.
2. In an authorized isolated v2 preview, manually pair five **independent identities**. Record each device ID and exact signed login epoch; DO storage and WebSocket attachment must survive a real Hibernation + wake, not just mock reconstruction.
3. Start the **72-hour minimum** observation window and record all five online devices at least hourly (start and end included) plus separate socket close/open and disturbance timestamps. Hourly snapshots demonstrate *sample coverage*, NOT continuous connectivity between points; capture transport-level and billing evidence for uninterrupted stretches.
4. Alternate idle periods, a small *nonsensitive read* by explicit device ID, bounded file/write/Shell tests only on disposable fixtures if separately permitted, transient network partitions, one revoked device and its remaining-device behavior, duplicate WSS epoch, wrong fingerprint/nonce and lost-reply `operation_id` receipt recovery. Unknown mutations **must not auto-replay**.
5. Export **full UTC-day** Cloudflare account-wide totals for every UTC calendar date touched by the interval, even partial first/last days. Record Workers requests, DO requests/GB-s, SQLite reads/writes, stored bytes; add account-wide existing DO consumption (including IMA). Note request-billing units may differ from raw WebSocket message counts; use the correct dashboard measures.
6. After 72h, compare the account totals against contemporaneous Free limits and establish actual hibernation by duration measurements. Re-check v1 health; make an explicit human security/rollback decision, rather than automatically activating v2.

## Offline completeness check (no network)

A local JSON file holds **references/measurement summaries only**: no raw private keys, bearer tokens, plaintext codes, unredacted command outputs, or identifying hostnames. Required top-level keys:

- `environment: "nonproduction"`, `start_utc` and `end_utc` (UTC ISO timestamps, at least 72h apart), `device_ids` (five unique device UUIDs).
- `hourly_samples`: one or more per hour, with first/last at the two window boundaries; each element `{ "at_utc": "...Z", "online_device_ids": ["<five-id-uuids>"] }`. Planned outages should be conducted and logged separately from the idle/steady five-online sampling period; do not misreport a disrupted period as uninterrupted coverage.
- `daily_account_usage`: one row for **each touched UTC date**, containing `date_utc`, `source_ref` (operator's sanitized dashboard evidence ID), `includes_other_durable_objects: true`, plus `workers_requests`, `do_requests`, `do_gb_seconds`, `sqlite_rows_read`, `sqlite_rows_written`, `sqlite_storage_bytes` numeric account totals.
- `evidence_refs` maps `human_confirmation`, `do_hibernation`, `idle_duration_comparison`, `reconnect_epoch`, `offline_denial`, `revocation`, `unknown_receipt`, `v1_isolation` to safe references for **human review**.

Run from a reviewed checkout:

    node apps/remote-control-agent/scripts/check-v2-soak-evidence.mjs /path/to/sanitized-evidence.json

Exit **0** only means `ready_for_manual_review: true`: the JSON has basic interval coverage, IDs, reference completeness and daily reported numbers with at least 20% Free quota headroom. Missing data or low headroom exits **1**; invalid/unavailable file exits **2**. **It does not certify actual uptime, true Hibernation, cloud dashboard authenticity, human pairing, zero secret leakage, safe Shell behavior or production readiness.** All sources must be examined independently by the owner. Synthetic unit test fixtures are *not* run evidence.

## Stop/go and rollback

**No-go** for stale/uncorroborated analytics, unknown owner approval, any credential leak, missing hibernation proof, unexpected durable CPU duration, Free budget headroom below agreed reserve, unexplained Shell replay, device isolation failure, or degraded v1. Stop and revoke only the authorized test devices / disable the isolated preview after a separate explicit host/cloud action decision. Never touch existing production v1 ingress/DO/Tunnel/secrets as an implicit rollback.

Complete the separate per-ticket real-host evidence for #47/#50/#51/#52/#54/#55/#56 first; keep #57 and #46 OPEN until the exact five-device 72h and owner-reviewed gate actually pass. No new CI workflow or recurring background job is required by this planning artifact.
