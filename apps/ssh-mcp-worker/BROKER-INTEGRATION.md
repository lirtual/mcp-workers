# Optional EdgeSSH Broker Integration — Draft implementation, denied unless broker token + host allowlist are configured

This is an **unreleased** extension to the existing SSH MCP Worker for the [EdgeSSH internal broker design](https://github.com/lirtual/EdgeSSH/pull/1). It supersedes the Q22=B direct production D1 + root `ENCRYPTION_KEY` copy proposal **only if the owner separately approves the architecture change**. This implementation/PR does not authorize merging, deploying EdgeSSH, configuring production secrets, or opening a real root SSH session.

## Why

The EdgeSSH deployment script automatically generates `ENCRYPTION_KEY` on first bootstrap, saves it as a Worker Secret, and cannot retrieve it by API. Do not rotate the production key or try to recover it through untrusted APIs. The new EdgeSSH `HostBrokerEntrypoint` may decrypt a *single allowed saved host* using the original Worker-only secret and return only that host's short-lived connection material over a private Service Binding RPC. The original root **encryption key never leaves EdgeSSH**, but the specifically allowed **root password / SSH private key WILL enter SSH MCP process memory** for a particular connection; this remains a major trust-boundary change.

## Isolation and optional binding

**Default:** Existing `ssh-mcp-worker` continues using the synthetic D1 + independent test `ENCRYPTION_KEY` path, unchanged. No new Worker, database, Queue or Agent.

After a separate production-integration approval, a deployer can add a named Service Binding in the **MCP Worker** configuration (illustrative JSONC; **not in the committed default config**):

```json
{
  "services": [{
    "binding": "EDGE_SSH_BROKER",
    "service": "edgessh",
    "entrypoint": "HostBrokerEntrypoint"
  }]
}
```

And set **independent** secrets/variables:
- On existing EdgeSSH Worker: `MCP_BROKER_HOST_IDS=...` (only explicitly approved UUIDs; empty rejects all) and `MCP_BROKER_TOKEN` (new strong random token, **not** `ENCRYPTION_KEY`). No separate `MCP_BROKER_ENABLED` toggle exists.
- On SSH MCP Worker: `MCP_BROKER_TOKEN` identical new **broker-only** token; continue separate `MCP_ACCESS_TOKEN` for MCP client authentication. Do not copy original root encryption Secret or D1 binding into MCP.
- `MCP_BROKER_FULL_ACCESS` is **unset** during first G5 CloudCone smoke; when a broker binding is present, the MCP gateway blocks all effectful commands except exact `pwd` or `printf G5_SSH_OK`, and only permits bounded `/etc` SFTP listing and `/etc/hostname` text read (plus metadata and receipt lookups). Host ID allowlist is independently enforced **inside EdgeSSH**. Enabling broader access needs **separate operator approval**, not merely passing this smoke.

A Service Binding alone is **not** an unforgeable caller identity. The independent broker token is mandatory; missing/invalid token, empty host allowlist, unknown host or changed pin fails closed. The two Workers must be in the same Cloudflare account. Changes to EdgeSSH's GitHub Actions auto-deployment configuration and durable production enablement must be explicitly reviewed at production rollout, because generic dashboard variables may not persist across automated deployments.

## Cross-request behavior

- The existing MCP `SshOperationsDO` still owns operation admission/receipts before SSH side effects, never the EdgeSSH Worker.
- `list_hosts` / `get_host` use sanitized RPC metadata with no plaintext credential fields.
- `ssh_exec`, short SFTP and managed session start ask `resolveHostForConnection` for a **fresh single-host** credential inside the already validated MCP operation flow; no long-term caching or storing in DO SQL/receipt outputs.
- The MCP Worker **does not fall back** to local D1 when a configured broker rejects a call; metadata with no allowed matching host remains denied/empty.
- The SSH engine still independently checks public DNS/IP, pinned SSH server fingerprint, connection lifecycle, timeouts and bounded result budget. Auto-running EdgeSSH `initialCommand` remains forbidden.
- Known-failure receipt survival across actual code upgrade/rollback is already proven; a genuinely unknown effect/tombstone across version change is **still unverified**. Do not replace that evidence with a failed receipt.
- First positive root SSH/SFTP is **not tested** by these code-only changes.

## Operational rollback (requires separate approval)

1. Clear the EdgeSSH broker host allowlist or revoke the dedicated broker token to deny all **new** broker credential resolutions.
2. Remove MCP `EDGE_SSH_BROKER` Service Binding/disable corresponding version, switch to previous synthetic-only MCP version. Keep the **same MCP DO namespace** so original operation receipts remain intact.
3. Never change EdgeSSH `ENCRYPTION_KEY`, production D1, its SSH sessions, or saved host records. Already-established remote sessions cannot be conclusively killed by revoking broker access alone; separately stop live MCP-owned sessions if necessary.
4. Check EdgeSSH WebSSH/SFTP baseline and only then mark rollout complete.

## Test scope

- EdgeSSH: isolated AES-GCM fixture, missing/wrong broker token and empty host allowlist reject before any D1 reads; only allowlisted hosts; metadata sanitized; `SELECT` only; invalid or untrusted host refused.
- SSH MCP: broker-stub metadata/credential RPC; no fallback on failures; read-only scope denies PTY, arbitrary root commands, all mutating SFTP.
- Reuse existing full checks; **no additional CI workflow**. Production EdgeSSH and CloudCone untouched.
