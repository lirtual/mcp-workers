# Post-deployment 09:00 scheduler acceptance (T17)

This is a **separate operator procedure**, not a PR-CI test and not a
ChatGPT automation. Do not mark #108 complete from a manual Run, a simulated
tick, or a deployment job still running.

## Activation gates

1. Confirm #106 has evidence for two consecutive successful, stable-secret
   production deployments and independent heavy GitHub→R2 and self-MCP tracers.
2. Confirm #107 has an authenticated manual Raindrop Run that returned a
   valid `workflow_result`. Keep its sanitized acceptance evidence.
3. Set the protected `workflow-mcp-worker` GitHub environment variable
   `WORKFLOW_MCP_ENABLE_SCHEDULE=true`, then manually dispatch **Workflow
   MCP Deploy**. Confirm the job is **completed/success** and that the
   generated Wrangler config has exactly `["* * * * *"]` under
   `triggers.crons`. Leave the flag set on subsequent ordinary deployments.
4. Select the **next real 09:00 Asia/Shanghai** occurrence strictly *after*
   the completed deployment; record its UTC timestamp. Shanghai 09:00 =
   01:00 UTC, with no daylight-saving conversion. The previous 09:00 cannot
   serve as evidence, and a tick at another minute does not count.

## Inspect durable D1 evidence

Run the following **read-only** SQL against the actual production
`workflow-mcp` D1 database (Cloudflare D1 console or Wrangler with the
correct *generated* production bindings). Do not use the placeholder ID from
the source `wrangler.jsonc`. All schedule times are Unix milliseconds.

```sql
SELECT schedule_key, last_evaluated_at, last_admitted_scheduled_time
FROM scheduler_state
WHERE schedule_key = 'raindrop-daily-snapshot:daily-nine';
```

The `last_admitted_scheduled_time` should reach the selected 01:00 UTC
occurrence. Next inspect the corresponding admission and Run:

```sql
SELECT a.run_id, a.source_type, a.source_key AS scheduled_epoch_ms,
       a.created_at AS admitted_at, r.state, r.definition_digest,
       r.engine_version, r.cf_workflow_version_id,
       r.started_at, r.ended_at, r.error_code
FROM run_admissions AS a
JOIN workflow_runs AS r ON r.run_id = a.run_id
WHERE a.workflow_id = 'raindrop-daily-snapshot'
  AND a.source_type = 'schedule'
ORDER BY a.created_at DESC
LIMIT 10;
```

Find a `source_key` exactly equal to the selected occurrence in
milliseconds, `admitted_at` after the deployment job finished, and the
matching source `trigger_json`. Check one admission for that occurrence
(no duplicate Run); an older successful Run is not acceptable evidence.

```sql
SELECT a.source_key, COUNT(*) AS admission_count
FROM run_admissions AS a
WHERE a.workflow_id = 'raindrop-daily-snapshot'
  AND a.source_type = 'schedule'
GROUP BY a.source_key
ORDER BY a.source_key DESC
LIMIT 10;
```

For the selected `run_id`, independently verify the executor:

```sql
SELECT s.step_id, s.state AS step_state, a.executor_type,
       a.state AS attempt_state, a.executor_version, a.executor_revision
FROM step_runs AS s
JOIN step_attempts AS a ON a.step_run_id = s.step_run_id
WHERE s.run_id = '<verified_run_id>';
```

The Raindrop `fetch` step must be Cloudflare-local; a GitHub executor
attempt for this Run fails acceptance. Preserve only sanitized Run/step IDs,
statuses, timestamps, digests and provenance in issue evidence.

## Verify public MCP and result

With the existing authenticated Workflow MCP connection call
`workflow_list` (definition/digest), then `workflow_status`,
`workflow_result`, and `workflow_logs` with the **same verified Run ID**.
Correlate the lifecycle timestamps with D1. If the Run succeeds,
`workflow_result.outputs.bookmarks` must be an array of 0–20 actual
records and `outputs.count` its independent upstream total. Check that
the result is queryable without publishing bookmark titles or URLs.

If the Run fails, timeouts, or the upstream rejects the request, record the
real `errorCode` and lifecycle events and leave #108 open. Do not create
a replacement manual Run and call it the scheduled occurrence.

Finally, retain the heavy GitHub→R2 archive tracer from the deployment as
separate regression evidence. Never include secrets, raw bookmark records,
lease nonces, signed URLs, or access tokens in issue comments.

## Recovery

If a real tick fails, inspect Cloudflare logs and the D1 rows above.
`misfire: latest` means the scheduler admits only the latest missed due
occurrence, not every missed day. For a controlled pause, set
`WORKFLOW_MCP_ENABLE_SCHEDULE=false` and redeploy; verify Cron is absent
before assuming it is disabled. Re-enable only after resolving the fault.
