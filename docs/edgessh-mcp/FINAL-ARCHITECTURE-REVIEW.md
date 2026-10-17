# EdgeSSH MCP — Final architecture and overengineering review (Q22=B)

**Review date:** 2026-10-17. **State:** first complete architecture synthesis, **operator authorized `to-spec` drafting; [Draft SPEC.md](./SPEC.md) published**. PR #81 remains Draft and docs-only. No EdgeSSH code/config/schema/deploy change.

**Source and delivery baseline:** SPEC §3.3 pins the upstream compatibility revision; SPEC §12 defines G0 approval, shared connection limits, CI ownership and isolated G5 closure. Earlier references to “current” source are historical, not a production-version assertion.

## 1. Decision reconciliation

| Choice | Current status | Meaning |
| --- | --- | --- |
| Q1=A | retained | Same Cloudflare account for both Workers and the existing EdgeSSH D1 |
| Q2=B | retained | Arbitrary SSH commands + SFTP mutation in first release |
| **Q3=A** | **superseded by Q22=B** | Credential decryption + SSH execution now belong to the MCP Worker **as well as** unchanged EdgeSSH, rather than EdgeSSH exclusively |
| Q4=B | retained | All EdgeSSH Saved Hosts are eligible; missing credentials/SSH fingerprint block *execution*, not listing |
| Q5=A | retained | Unique MCP ingress Bearer via existing Portal pattern |
| Q6=B | retained | Interactive Shell and live session-owned background work across MCP calls; no immortal connection or remote daemon |
| Q7=A | retained | Human-pinned server fingerprint from EdgeSSH host record; no AI auto-accept |
| Q8=A | retained | Unattended, potentially destructive remote operations |
| Q9=B | retained | Durable admission/duplicate protection |
| Q10=A | retained | Text-only bounded SFTP operations |
| Q11=A | retained | Lost connections remain lost; no automatic command/session resurrection |
| Q12=A | retained | Stop only demonstrably owned *live* session jobs |
| Q13=A | retained | Every effectful input batch, exec, session start and SFTP mutation has operation ID + digest |
| **Q14=A** | **superseded by Q22=B** | Receipt admission is authoritative **inside MCP's own execution boundary**, not in unchanged EdgeSSH |
| Q15=A | retained | Finite concurrency, session idle/absolute lifetime and output retention |
| Q16=A | retained | Explicit UTF-8 file writes/overwrites/deletes, small payload |
| Q17=A | retained | 30-day normal terminal receipts; unresolved minimal markers persist |
| Q18=A | retained | Human reconciles unknown side effects before a deliberate *new* operation; no blind replay |
| Q19=A | retained | Fail closed on persistence outage, except authenticated owner-scoped best-effort stop |
| Q20=A | retained | Rotate token to block new calls; no guarantee of immediate fleet-wide remote-process termination |
| Q21=no EdgeSSH changes | retained | The independently maintained fork, its production D1 schema, Worker and secrets remain untouched |
| **Q22=B** | **accepted** | MCP reads existing encrypted EdgeSSH D1 host rows using copied root secret, independently executes SSH and persists receipts |

Historical ADR-0001 Q3=A and ADR-0003 Q14=A are kept as decision provenance but explicitly marked superseded. [Current architectural authority is ADR-0005](./adr/0005-independent-mcp-ssh-shared-edgessh-credentials.md).

## 2. Minimal viable architecture

```text
                   MCP Portal / ChatGPT / Codex
                               |
                       dedicated Bearer
                               v
             mcp-workers/apps/ssh-mcp-worker  [ONE Worker]
             ├─ MCP ingress + strict tool validation
             ├─ host reader ---- fixed SELECT -------------> Existing EdgeSSH D1
             │    decrypt with MCP-side ENCRYPTION_KEY copy  [NO MCP WRITES]
             └─ MCP-owned SQLite-backed Durable Object
                   ├─ atomic operation receipts / dedup
                   ├─ bounded live session/channel ownership
                   ├─ bounded output + session status
                   └─ SSH implementation via cloudflare:sockets
                                           |
                                     public SSH hosts

    Unmodified EdgeSSH Worker / WebSSH / SFTP frontend ------> same existing D1
```

No Service Binding to EdgeSSH Worker (no suitable RPC available), no browser-cookie bot, no independent host-sync database, no extra deployed Worker for session controller, no queue/R2/Workflows/remote Agent. The Durable Object is a class and persistent resource **within the one MCP Worker application**, not an additional standalone MCP Worker; its persistent receipt store is separate from EdgeSSH's unchanged database.

### Source-level facts verified

- `migrations/0001_accounts.sql`: `hosts(id, account_id, encrypted_payload, updated_at)`; `migrations/0002_workspace_state.sql`: single `workspace_state` contains `account_id`.
- `src/accounts/crypto.ts`: ciphertext `v1.<base64 iv>.<base64 ciphertext+tag>`; AES-256-GCM uses per-record AAD `edgessh:v1:${accountId}:${hostId}`. Changing the account ID or host ID invalidates decryption.
- `src/accounts/hosts.ts`: encrypted `HostPayload` includes `fingerprint`, `initialCommand`, login method, credentials. `fingerprint` may be empty; check it every time. **Do not execute `initialCommand` on MCP connection.**
- `src/accounts/github-auth.ts`: HKDF derived GitHub login-flow and session-cookie signing keys from **ENCRYPTION_KEY**. The shared secret is not a host-specific decrypt-only key.
- `src/backend/durable-object.ts`: existing EdgeSSH session is WebSocket-shaped and closes restored sessions with `Worker session restarted; reconnect required`. Cannot promise to invoke it via a new RPC without changing EdgeSSH.
- Cloudflare [D1 bindings](https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases) and [D1Database APIs](https://developers.cloudflare.com/d1/worker-api/d1-database/) are read/write capable: **SELECT-only is code policy, not enforced read-only privilege**.
- Cloudflare [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) and [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) limit reliable continuity. A connection keeps the DO resident for up to 15 minutes of eviction protection; this is **not** a session lifetime cap or guarantee.
- Upstream EdgeSSH source is Apache-2.0 licensed; if reusing its SSH primitives, preserve attribution and notices. Avoid indiscriminate vendoring of browser UI/auth code.

## 3. Security threat audit

| Threat | Minimum mitigation | Residual risk or gate |
| --- | --- | --- |
| MCP secret compromise | Unique high-entropy `MCP_ACCESS_TOKEN`; no shared token; authenticated MCP Portal and fail-closed ingress | Attacker can operate on **all eligible hosts** while token is valid. Q8 chose no per-call human consent |
| Copied root `ENCRYPTION_KEY` | Secret only in MCP Worker deployment, never tools/logs/output/receipts; short-lived decrypted credentials in memory | **Unavoidable:** SSH password/key exposure for all hosts; same root derives GitHub login-signing keys when GitHub mode is used |
| EdgeSSH D1 corruption or malicious writes | Fixed SELECT-only prepared queries, no generic SQL admin API, no migrations/DDL against existing D1, review/static gate | **Unavoidable:** D1 Binding exposes write APIs, not a true DB read-only capability |
| Unknown or changed host key | Compare cryptographically verified actual host key to stored nonempty `fingerprint` before credentials | A saved row's `fingerprint` may be missing/stale, so block that host until human updates its trust |
| DNS rebinding / SSRF | Preserve EdgeSSH public-target DNS/address validation; reject private/reserved/metadata targets and blocked ports; revalidate after resolution | Enforcement must be tested against malicious DNS and IPv6 corner cases |
| AI prompt injection and untrusted remote output | Treat tool outputs/file contents as untrusted data; never use them to relax authorization; bounded inputs/outputs | **Remote shell/SFTP can deliberately print or read remote secrets**, including keys; it is not possible to guarantee arbitrary tool output contains no secrets. This is inherently high-privilege, not a sandbox. |
| D1/schema/key drift | Derive workspace account ID, decrypt `v1` AAD, fail closed on unknown versions/malformed rows; compatibility fixtures | Upstream schema/crypto changes may break the MCP until reviewed; do not edit upstream records to self-heal |
| Out-of-date host intent | Freshly read host data/fingerprint for every new operation; bind operation ID to host ID + canonical payload digest + record revision/fingerprint | `updated_at` can remain unchanged when other fields mutate; do not trust timestamp alone |
| Lost/duplicated command | Durable admission before any dispatch, atomic claim, digest conflict, idempotent identical requery, no blind repeat of in-flight/unknown | A receipt does **not** guarantee remote exactly-once side effects; remote command may already have changed state |
| Interactive input duplicates | Operation ID for each input batch, serialized order per session, bounded buffer/output | Ambiguous partial delivery must remain unknown and cannot be resent automatically |
| Long-running/leaked session | Small fixed concurrency, idle/absolute timeout, bounded output, explicit stop with live ownership proof | Remote descendants may outlive SSH and cannot be killed by stale PID safely |
| Receipt-store failure | Deny new effectful work; only narrow authenticated live session close/stop allowed, report unknown if no durable result | Stopping SSH channel does not prove detached process terminated |
| Token rotation | Old Bearer rejected on every new request, no bearer inherited as permanent session access | Prior sessions can live until timeout/controlled stop; remote effects are not undone |
| SFTP partial edits | Strict UTF-8/text size, explicit overwrite/delete, per-mutation receipts; test temp-file/rename server behavior | No universal atomic replacement guarantee, no full rollback on unknown |
| Rolling back MCP | No EdgeSSH schema change, additive MCP DO receipt schema, preserve operation IDs/unknown receipts | A rollback to code that cannot read new receipts must fail closed, not silently clear/replay them |

**Cannot honestly claim under Q22=B:** strictly isolated host secrets, a database-enforced SELECT-only credential, production credential risk equal to Q22=A, instant forced termination of remote jobs, or exactly-once execution.

## 4. Overengineering audit

| Candidate component | Decision | Why |
| --- | --- | --- |
| 1 independent MCP Worker in `mcp-workers` | **Keep** | Existing monorepo contract, separate ingress/secret/deploy |
| D1 binding to EdgeSSH existing host catalog | **Keep** | User-approved automatic reuse; no new host-sync database |
| `ENCRYPTION_KEY` copied into MCP Worker | **Keep only because Q22=B** | Required by v1 encrypted host payload, significant accepted risk |
| One MCP-owned session/receipt DO namespace | **Keep** | Managed Shell after tool call + durable dedup without additional Worker |
| Custom SSH engine from scratch | **Reject** | Use tested Workers-compatible implementation / minimally adapt licensed SSH primitives |
| Host credential sync jobs | **Reject** | D1 is the on-demand source |
| Extra auth/OAuth Gateway | **Reject** | Dedicated Portal Bearer already selected |
| Per-host RBAC/approval workflow | **Reject for v1** | Q4=B/Q8=A explicitly chose all saved hosts/unattended |
| D1 receipt table inside EdgeSSH DB | **Reject** | Violates unchanged-EdgeSSH storage contract |
| New remote Agent / daemon | **Reject** | Q12 forbids detached process supervision |
| Cloudflare Workflows/Queues/R2 | **Reject** | No demonstrated need beyond bounded live SSH and DO receipts |
| Separate binary SFTP service | **Reject** | Text-only scope Q10=A |
| Automatic reconnect/replay/restore | **Reject** | Q11/Q18 forbid unsafe replay |
| Extra CI pipeline | **Reject by default** | Reuse existing checks and add targeted tests only |

Do not turn this into a multi-tenant SSH gateway, generic distributed job platform, shared credentials service, or continuous session pool.

## 5. Implementation readiness gates (for a subsequent, separately approved Spec)

1. **Offline crypto fixture gate:** verify known fixture ciphertext AAD, Base64 key length, wrong account/host/key failure, deleted/rotated host, future ciphertext version; no real operator credentials in tests.
2. **SSH feasibility gate:** prove a single Workers-compatible transport plus headless exec, interactive PTY input/status/stop, session-owned jobs and SFTP without fake EdgeSSH browser WebSocket or duplicate SSH implementations. Verify Apache-2.0 attribution if vendored.
3. **Security gate:** prove fingerprint validation before password/private-key auth, public-target/DNS rebinding checks, intentionally missing/changed pin fails closed, `initialCommand` not auto-executed, no **stored connection credentials/root key** in tool payloads/errors/receipts/logging. Arbitrary SSH/SFTP output itself may contain sensitive remote data and cannot be generically sanitized.
4. **Receipt gate:** atomic admission under concurrent duplicate requests, same-ID different digest rejection, input-batch dedup, fail before SSH dispatch on durable-store failure, restart in-flight => `unknown`, unresolved markers survive retention, narrow stop remains authorized.
5. **Lifecycle gate:** bounded sessions/output/timeouts and graceful/uncertain stop, detached descendants not misrepresented as killed, no automatic PTY resurrection after DO restart or deployment.
6. **Integration gate:** read-only-**by-code** EdgeSSH D1 SELECTs, independent Bearer header actually delivered via MCP Portal and rejected when incorrect; no generic query/write tools; production DB privilege caveat documented.
7. **Release gate:** staging with synthetic hosts and test SSH targets; EdgeSSH source/Worker and production D1 unchanged; deploy MCP separately only after approval; rollback must retain receipt identities and unknown markers; validate Cloudflare free-plan resource usage if applicable.

**Stop rather than improvising** if Worker SSH library/PTY feasibility or authentic Portal Bearer delivery fails. Those are genuine gates, not reasons to add a proxy host, plaintext credentials API, second Worker or background scheduler.

## 6. Final recommendation and sign-off

**Q22=B is coherent with all other selected behavior once Q3 and Q14 are explicitly superseded.** It is also more security-sensitive than the originally proposed EdgeSSH-private-RPC model: unavoidable shared root key (also used for GitHub login signing) and a write-capable D1 binding. Those costs are inherent in auto-reusing encrypted upstream host records without modifying the upstream project.

This is the **smallest design that implements the accepted feature scope under Q21+Q22=B**, *not* a claim of maximal credential isolation. No unnecessary component has been added. The operator has now requested `to-spec` and [Draft SPEC.md](./SPEC.md) is available for review. **This authorizes spec creation only, NOT implementation, production secret/database/SSH access, merge or deployment**. Residual risks remain explicit acceptance gates. PR #81 stays Draft.
