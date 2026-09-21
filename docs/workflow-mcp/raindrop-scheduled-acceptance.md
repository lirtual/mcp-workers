# T17 — real scheduled Raindrop occurrence

## Observed baseline (2026-09-21)

The Cloudflare production `workflow-mcp-worker` already has **exactly one**
`* * * * *` Cron, deployed by Wrangler (latest verified deployment
`be89526a-8726-4df4-b208-855b03fefacf`). This is the engine's minute tick,
not an additional business-time Cron. The source-generated config enforces
exactly this value and fails closed on missing or duplicate scheduler Crons.
Do not add another Cloudflare Cron or GitHub/ChatGPT recurring trigger.

`raindrop-daily-snapshot` compiles to `0 9 * * *`,
`Asia/Shanghai`, `misfire: latest`. The actual due time is
**01:00:00 UTC / 09:00:00 China Standard Time**. The minute tick evaluates
the compiled definition using the durable `scheduler_state`; admission uses
a deterministic occurrence key. It must not backfill all missed days.
The previous #107 successful manual Run (20 returned items, 503 upstream)
does not qualify as a scheduled occurrence.

The 2026-09-21 local 09:00 boundary passed before the production Cron was
enabled. As of `2026-09-21T08:51Z`, the live D1 state evaluated
`raindrop-daily-snapshot:daily-nine` but had no scheduled admission.
The first prospective business occurrence is **2026-09-22T01:00:00Z**
(2026-09-22 09:00 Asia/Shanghai). Never claim acceptance from a simulated
clock, the presence of a Cron, a manual Run, or a green deployment.

## Independent post-deployment verification (read-only)

Wait until the selected deployment job is **completed/success**, and then
until the real 09:00 occurrence has elapsed. On GitHub Actions, manually
dispatch **Workflow MCP Scheduled Acceptance** from the reviewed `main`
commit with the exact `expected_utc` (for the first prospective occurrence:
`2026-09-22T01:00:00.000Z`) and the actual prior successful
`deploy_run_id` (for the T16 deployment: `35579720076`). This is a
separate read-only job; it does not redeploy, migrate D1, execute
`workflow_run`, add Cron schedules, or send notifications. Its job requires
existing `workflow-mcp-worker` GitHub environment credentials and uses
fixed queries and MCP reads only. Do not send tokens to the chat.

The bounded verifier:
1. Confirms the referenced deployment completed successfully before the
   occurrence, and rejects future or more-than-48-hour-old occurrences.
2. Reads D1 `scheduler_state` and its unique schedule admission/Run for the
   exact UTC epoch. Any missing/duplicate/incorrect trigger fails closed.
3. Cross-checks `workflow_list` and `workflow_get` definition digest,
   `workflow_status` terminal state/engine, `workflow_result` and
   `workflow_logs`. For success, it validates real 0–20 bookmark records,
   the upstream count and lifecycle markers. Errors are truthful failures,
   never substituted with empty successful outputs.
4. Writes a 14-day artifact containing timestamps, Run/deploy IDs, definition
   and engine provenance, record count, SHA-256 digest and event names.
   **No bookmark titles, URLs, bearer token, or signed links** are exported.
   Preserve the artifact outside Actions if longer retention is required.

If no D1 scheduled admission exists, do not manufacture an occurrence by
calling `workflow_run`. Inspect the minute Cron, scheduler errors, and D1
state without mutating it. If the upstream fails, record the actual terminal
error code, investigate the source, and assess recovery for a **future**
legitimate occurrence. Never reset `scheduler_state` or backdate an
occurrence merely to pass acceptance.

## Independent heavy regression

The `web-archive-smoke` GitHub/OIDC → R2 heavy tracer is a **separate**
regression. Run the approved `run-deploy-tracer.ts` against the deployed
Worker, or authorize a distinct `full_acceptance` workflow. It must not
be dispatched to execute Raindrop. A green Raindrop result does not imply
the heavy regression passed. Check post-job GitHub executor and R2 artifact
evidence independently.

Close #108 only after both the actual post-job scheduled occurrence and
the independent heavy regression have verified evidence. The schedule is
read-only: no Raindrop bookmark mutation, no notifications, and no second
scheduler.
