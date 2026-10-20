# P0-3 / P0-4 isolated verification — 2026-10-20

**Evidence class:** real Cloudflare SDK and D1 tests, with intentionally limited security and Cron coverage. **NOT full P0 acceptance.** No existing production Worker/DB was changed.

## P0-3: Streamable HTTP SDK interoperability

Test environment: direct WSL2 Ubuntu 24.04, Node.js 22.21.0; isolated local NPM workspace; official `@modelcontextprotocol/sdk@1.32.1` (legacy), `@modelcontextprotocol/client@2.3.1`, `@modelcontextprotocol/server@2.3.1`, Zod 4. Test-only `wf-p03-sdk-20261020` Worker used official v2 `createMcpHandler` and a read-only `ping` tool. Endpoint access was limited by a newly generated temporary test secret.

| Client test | Actual observation | Conclusion |
| --- | --- | --- |
| v2 2.3.1 client → official v2 server, in process | Connect, `listTools`, `callTool` all passed | PASS for tested case |
| v1 1.32.1 client → official v2 server, in process | Connect, `listTools`, `callTool` all passed | PASS for tested case |
| v2 2.3.1 client → Cloudflare Worker v2 server over real HTTPS | Tool `ping` discovered, result `cloud-ack:new-sdk` | PASS |
| v1 1.32.1 client → same Cloudflare Worker over real HTTPS | Tool `ping` discovered, result `cloud-ack:old-sdk` | PASS |

**Limits:** these tests establish client library interoperability with **one server version and one simple read-only tool**. They do not cover every advertised protocol revision, negotiated session lifecycle, authenticated enterprise MCP endpoints, streamed notifications, redirects, SDK 2026-only capabilities, or type/schema drift. **Do not mark the entire 2025/2026 compatibility matrix passed.**

## P0-3: SSRF and authority isolation

No prohibited/unsafe network targets were queried. Full private/loopback/metadata/redirect/DNS rebinding network probes were **not executed**; attempting to run an adversarial request batch was blocked by execution environment safety checks. Only isolated public Worker-to-Worker connectivity from the prior round and the real SDK HTTPS connections above are proven. Credential-per-target isolation and origin/redirect stripping are **not proven**. P0-3 security gate **OPEN**.

## P0-4: one deployed tick + D1 runtime plans

Test resources: throwaway D1 `wf-p04-schedule-20261020` and a single isolated Worker `wf-p04-scheduler-20261020`. Cloudflare API independently confirmed exactly one deployed `* * * * *` Cron Trigger. The Worker had runtime-manageable D1 `schedules` and unique `receipts(schedule_id,local_occurrence)`. A protected test-only `/tick` endpoint supplied synthetic timestamps so DST and concurrent admission could be tested without waiting for actual dates. Each admitted occurrence only inserted D1 evidence; **no real business Workflow was started**.

| Scenario | Actual remote D1 / API evidence | Result |
| --- | --- | --- |
| Runtime creation of three plans | Created America/New_York 02:30, America/New_York 01:30, and UTC 12:34 without Worker redeployment | PASS for plan store/edit |
| Spring-forward 2026-03-08 nonexistent 02:30 | No `gap` receipt with local `2026-03-08#02:30` | PASS |
| Fall-back 2026-11-01 repeated 01:30 | 05:30Z admitted; 06:30Z duplicate for same `2026-11-01#01:30` key | PASS |
| Eight simultaneous synthetic ticks | One admitted receipt for same UTC 12:34 occurrence | PASS |
| Recheck after missed 12:34 occurrence | Already-seen occurrence reported duplicate, no extra receipt | PASS for that bounded test |
| Update runtime plan to UTC 12:36 | New occurrence admitted without redeploy | PASS |
| Independent D1 verification | Each local occurrence key appears exactly once; no nonexistent spring-forward key | PASS |
| **Native Cloudflare scheduled() firing** | Cron binding confirmed, **zero actual scheduled tick receipts** at time of audit | **NOT VERIFIED** |

**Test assertion correction (not a system fault):** an initial check expected only one `overlap` schedule receipt in all data; it incorrectly ignored that its normal spring-day 01:30 legitimately fired as another simulation. The follow-up audit compared the **specific fall-back local occurrence key** and correctly counted one, with distinct legitimate March and November dates preserved.

**Important limitations:** the 181-minute backward scan was a deliberately small **PoC algorithm**, not a production efficient Cron engine or full Cron expression parser. A finished implementation should use indexed next-due scheduling / bounded computations, explicit schedule precision, retention and missed-run policy; must prove actual `scheduled()` invocation and durable Run creation, not merely the protected simulation endpoint. A modified schedule on the same day was intentionally recorded under two different wall-clock occurrences; production revision semantics remain a spec decision.

## Next safe closure requirements

- P0-3: verified SSRF controls, no cross-target credential forwarding, redirect/DNS behavior, and broader real protocol matrix.
- P0-4: real Cloudflare scheduled invocation, D1 due selection without O(N*minutes) repeated scans, repeatability at DST and downtime, unique actual Run creation, and cost/precision measurements.
- P0-5: real GitHub OIDC + atomic Claim/callback fact persistence tests remain pending.

**Q1–Q50 unchanged.** All code and test keys are scoped to scratch/throwaway resources. Do not claim AC-08/27 or AC-11/29 fully closed on these results.
