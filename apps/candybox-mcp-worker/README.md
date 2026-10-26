# CandyBox MCP (Spec #325)

One bounded Cloudflare Worker for anonymous Dub links, EnvShare encrypted text,
Litterbox file uploads and persistent DuckDuckGo Email Protection forwarding aliases.
It reuses the shared Portal Bearer ingress; it does **not** implement a general HTTP
proxy, alternate providers, account manager, storage, queue, Cron or workflow.

## Current release state: not accepted

**Only `candybox_capabilities` is registered by the live Worker entrypoint.**
The four write contracts and outbound implementations are exercised by isolated
tests, not exposed by production `tools/list`. This is intentional, not a
fully delivered four-tool service.

ChatGPT native tool approval can be remembered for a conversation. MCP annotations
do **not** prove a fresh user approval for every call. Spec #325 requires strict
per-invocation approval, so **all write tools remain disabled** until a real ChatGPT
client proves this requirement. In particular, do not add an `approved: true`
tool argument, a persistent rollout toggle or a substitute confirmation UI.
If the host cannot enforce approval, keep the tool disabled and record Blocked.

Separate release blockers include:

- Verify that anonymous Dub creation still works with random `dub.sh` keys,
  full queries and public stats disabled by default.
- Match EnvShare's **historical v2 encrypted link format** byte-for-byte,
  including IV, tag, Base58 and fragment handling. The current outbound adapter
  is *unverified* and must not be enabled based on mocked responses alone.
- Prove `_meta["openai/fileParams"]` survives One-MCP, observe the trusted
  ChatGPT temporary download origin, validate Workers multipart with Litterbox,
  and independently download a bounded test file. Production has **no trusted
  file-host allowlist** and rejects all file downloads.
- Verify the unofficial DDG API, an authenticated read-only dashboard probe,
  and separately approved actual alias creation plus safe test-email forwarding.
- Perform real ChatGPT acceptance including the second write in the same
  conversation *after the remembered-approval option* and one declined call.

Do not add Portal registration or publish/merge without explicit approval.
No old Share Tools scripts are removed before successful replacement acceptance.

## Contracts and bounds

| Tool | Status | Input | Result |
| --- | --- | --- | --- |
| `candybox_capabilities` | discoverable, read-only | none | per-feature state, file/text limits, DDG status |
| `candybox_shorten_url` | disabled | `url`, optional `public_stats=false` | confirmed short link |
| `candybox_share_text` | disabled | `text`, optional bounded TTL and reads | confirmed encrypted URL |
| `candybox_upload_file` | disabled | one native file, optional 1h/12h/24h/72h | confirmed file URL and byte count |
| `candybox_create_duck_address` | disabled | none | one new private @duck.com address |

EnvShare defaults to 24h/one read and limits input to 16 KiB UTF-8.
Litterbox defaults to 24h and limits actually streamed bytes to 10 MiB.
There are no automatic retries after a dispatched write. An uncertain upstream
result is not proof of failure or successful creation. URL queries can contain
secrets disclosed to Dub. ChatGPT and CandyBox receive text before encryption,
and Litterbox receives files in plaintext. DDG aliases forward indefinitely
until managed with the DuckDuckGo account, not as expiring mailboxes.

## Configuration and release

`MCP_ACCESS_TOKEN` is required; `CANDYBOX_DDG_TOKEN` is an **optional**
Cloudflare Worker Secret sourced only from the same-named GitHub Environment
Secret for the selected Worker. The token is never placed in tool inputs,
plaintext Variables, README, logs or responses. An absent GitHub Secret does
not delete an old Cloudflare Secret binding: a stale remote binding blocks
preflight, and revocation requires controlled removal and independent readback.
No empty placeholder is used.

The existing `Release Worker` workflow is manual, selects exactly one Worker,
checks current `main` twice and serializes on the selected Worker. A release
or Portal attachment still requires its own Owner authorization. All normal
CI and Wrangler dry runs are offline from third-party create calls.

## Tests

`pnpm --filter candybox-mcp-worker check` runs typechecking, synthetic MCP
contract tests and Wrangler dry run. Repository-level release and selector tests
check the allowlist, token staging, optional Secret parity and logging policy.
These prove local behavior only; they do not constitute live ChatGPT, upstream
or production acceptance.
