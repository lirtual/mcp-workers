# G5 isolated rollout and rollback — SSH MCP v0.1

Status: **PARTIAL / BLOCKED** (2026-10-18). This is an isolated acceptance record for [#95](https://github.com/lirtual/mcp-workers/issues/95) under parent [#83](https://github.com/lirtual/mcp-workers/issues/83), not a production release.

## Ownership / isolation

- Implementation: `implementation/ssh-mcp-v0.1`, Draft PR #96. The existing app/package and future production Worker name remains `ssh-mcp-worker`.
- Disposable test Worker: `ssh-mcp-g5-lab` at `https://ssh-mcp-g5-lab.aiyaya.workers.dev/mcp`. No custom domain or existing Worker is reused.
- New SQLite-backed `SshOperationsDO` binding: `SSH_OPERATIONS`. Do not change its migration tag `v1` or reset DO identity as a rollback technique.
- New synthetic D1 database: `ssh-mcp-g5-fixture`, binding `EDGE_SSH_DB`. It contains exactly one checked-in synthetic encrypted host fixture generated from pinned EdgeSSH. Discover its disposable database ID with `wrangler d1 list`; do not hardcode an existing EdgeSSH production D1 ID.
- Dedicated Worker secrets: `MCP_ACCESS_TOKEN` (independent test-only Bearer) and `ENCRYPTION_KEY` (the synthetic fixture key). Secret **values must not appear** in this document, repository, shell logs, tool responses, or receipts. No copied production root key.
- Existing `edgessh` Worker, `edgessh-accounts` D1, real EdgeSSH secret, SSH servers, and live Portal entries are out of scope and were not modified.

Authorization scope: operator agreed in chat to the previously proposed minimal *isolated* G5 plan; see parent #83 audit comment. This does not authorize real credentials, production SSH, changing the live Portal, PR merge, or production release.

## Evidence already collected (do not repeat without relevant changes)

1. 2026-10-18: Cloudflare created `ssh-mcp-g5-fixture` with only synthetic `workspace_state` and `hosts` records. `SELECT COUNT(*) FROM hosts` returned 1.
2. Cloudflare Wrangler `4.130.0`, Node `24.21.0`, pnpm `10.17.1`: deployed `ssh-mcp-g5-lab` from PR #96 revision `5f3d294`; Worker upload, DO migration `v1`, D1 binding, and `workers.dev` trigger succeeded.
3. Cloudflare script bindings list contains the test-only secret names `MCP_ACCESS_TOKEN` and `ENCRYPTION_KEY`. No value was read from Cloudflare.
4. Live unauthenticated HTTP checks: `GET /` -> **404**; `GET /mcp` without Bearer -> **401**; incorrect Bearer -> **401**.
5. #84–#94 were individually closed with their own approved G0–G4 evidence. Reuse that evidence rather than rerunning the complete protocol/security matrix.

These facts **do not** establish valid-Bearer MCP success, real ChatGPT Portal connectivity, SSH/SFTP against a public disposable target, rollback/unknown-receipt continuity, or production readiness.

## Exactly what remains for closing #95

- [ ] Register/connect **this isolated test URL** via the actual ChatGPT MCP Portal; confirm an authenticated Portal call to `tools/list` and a read-only `list_hosts` against synthetic D1. Direct `curl` to the Worker alone does not qualify.
- [ ] Verify an incorrect token is refused on the same Portal path (the direct-origin 401 is already proven).
- [ ] Provide a disposable, operator-owned, *publicly reachable* SSH test target (never an existing production host). Generate a new synthetic encrypted catalog entry with its actual host-key pin and a new synthetic login credential. Prove one harmless Exec/SFTP operation through Portal to this fixture. The checked-in `fixture.example.test` deliberately cannot serve as an external SSH target.
- [ ] Verify a rollback/disable of **only** the test Worker leaves the preexisting EdgeSSH service unaffected. After a compatible Worker version restoration, confirm the same DO namespace and durable receipts/unknown tombstones remain; never erase them to simulate a clean rollback.
- [ ] Archive the observed Portal calls, isolated SSH fixture receipt, original and restored version IDs, rollback results, and non-impact confirmation in #95. Only then close #95 and parent #83.

Do not add another Worker, DB, agent, queue, auth system or redundant CI. Do not repeat G0–G4 unless a shared component changed.

## Rollback and break-glass

If the test Worker needs immediate isolation, **disable only its workers.dev subdomain** (Cloudflare Worker script subdomain setting). Do not delete `edgessh`, `edgessh-accounts`, the test DO namespace, or the test D1 while reconciliation is pending. For code rollback, redeploy a previously approved compatible `ssh-mcp-g5-lab` version while retaining the existing `SSH_OPERATIONS` binding and `v1` migration; incompatible receipt/schema versions must fail closed instead of clearing operation IDs or replaying unknown effects.

Rotating or revoking the test Bearer affects only future MCP calls; it is not proof a remote shell stopped. Rotate its separate synthetic encryption key only in conjunction with a deliberately regenerated synthetic D1 fixture (old ciphertext will not decrypt). D1 bindings are platform-write-capable even though application queries are SELECT-only. Copied production EdgeSSH root secrets would materially expand credential/cookie risk and are forbidden here. SSH output can contain remote secrets; do not copy it into receipts or logs.

After acceptance, the test route can be disabled and its fixtures disposed of **only after** evidence and unknown-receipt preservation checks are complete. Production migration, source merge, real EdgeSSH D1/key binding and any actual SSH host access each require separate approval.
