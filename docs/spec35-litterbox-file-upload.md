# Spec #35 — Litterbox trusted file upload boundary

Status: **source candidate, not deployed and not production-accepted**.
Companion Provider source: `lirtual/cloudflare-actions#42`. Workflow source: `lirtual/mcp-workers#650`.

## One existing authorized Run (no parallel uploader)

The sole permitted Plan has **one manual-only** `action.run`:
`executor=cloudflare`, `provider=litterbox`, `action=litterbox.upload_file`,
with the exact digest returned by `workflow_validate`. Its input has only
`{file_name:{ref:"inputs.file_name"},size_bytes:{ref:"inputs.size_bytes"},sha256:{ref:"inputs.sha256"},time:{ref:"inputs.time"}}`.
No Cron, Webhook, GitHub event, child, Saga, extra Step, literal URL or file
is allowed. Publish requires the existing exact Provider Worker Version ID,
digest and Cloudflare Action approval checks.

After such an immutable Plan is published, the user must explicitly select
the file and authorize a separate `workflow_litterbox_upload` MCP call.
The top-level `file` is declared as OpenAI `fileParams` and receives
`download_url` and `file_id`, with optional `file_name`/`mime_type`.
A positive earlier read-only probe is NOT independent provenance attestation.

The file reader currently accepts **only** HTTPS `files.oaiusercontent.com`,
requires a `file_...` reference, rejects user-info, ports, fragments,
redirects, bad responses and files outside the 1 byte–10 MiB range. It streams at
most 10 MiB into ephemeral memory, hashes SHA-256 and forwards **only the bytes
and bounded metadata** over the existing private `ACTIONS` Service Binding.
A mismatched real ChatGPT download host must block the upload until confirmed;
do not expand to arbitrary URLs or infer the host from the file ID.

The MCP call creates a real native Workflow Run with only
`{file_name,size_bytes,sha256,time}` in D1. It durably reserves the
existing `cloudflare_action_invocations(run_id,step_id)` fence before exactly
one Provider RPC. The Provider revalidates exact Worker Version and contract
digest, metadata and bytes, and sends a single fixed multipart POST to
Litterbox without credentials or redirects. No automatic retry on ambiguous
results. The native Workflow **only waits for the already durable Step
receipt** and cannot run the upload itself; a missing wake cannot cause a
second POST. Public Litterbox URL may be persisted as the result; the private
ChatGPT file URL, ID and content never enter D1 or a native event.

Runtime publication/admission locks, cancellations and Run history are
preserved. There is no new Worker, R2, queue, scheduler, public file gateway or
external upload endpoint other than the fixed Litterbox target.

## Remaining real acceptance

- Determine the **actual** OpenAI file download origin from a verified
  client-selected disposable attachment, without echoing/logging the URL.
- Confirm the platform's user confirmation/consent boundary. Tool annotations
  and an authenticated publish grant alone are not independent proof that
  the owner approved each irreversible file upload.
- Separate explicit authorization for protected Provider then Consumer
  production releases, current Version readbacks, One-MCP Portal sync and
  client refresh.
- One real explicitly authorized **non-sensitive** file: byte-level upload,
  independent download/hash comparison, allowed TTL and 10 MiB policy checks.
  Do not test wall-clock expiry by replaying an unknown POST.
- Audit actual Run/Step/Invocation records, no persisted signed download URL
  or file bytes, and existing five business Workflows still active.

Until these stages pass, do not call the uploading tool in production,
do not claim successful Litterbox transfer or close Spec #35. The
independent Dub short-link longevity failure is not resolved by this work.
