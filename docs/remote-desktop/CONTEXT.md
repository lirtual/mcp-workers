# Remote Desktop MCP — CONTEXT (research only)

> Decision baseline 2026-09-23, rounds 1–3. Not an approved Spec, implementation, deployment, or activation of privileged tools. The previous initiative [#170](https://github.com/lirtual/mcp-workers/issues/170) and [#178](https://github.com/lirtual/mcp-workers/issues/178) were closed as **not planned**, not accepted. This documentation is on an independent research branch. Historical [CONTEXT](https://github.com/lirtual/mcp-workers/blob/prototype/remote-desktop-vpc-178/.scratch/remote-desktop-vpc/CONTEXT.md) and [decision log](https://github.com/lirtual/mcp-workers/blob/prototype/remote-desktop-vpc-178/.scratch/remote-desktop-vpc/decision-log.md) remain unchanged.

## Domain vocabulary

| Term | Contract |
| --- | --- |
| Remote Desktop MCP | Personal remote MCP entry calling an authorized subset of local open-source Desktop Commander tools; not the proprietary hosted UI. |
| Client / client authentication | Caller of public `/mcp`, authenticated with OAuth. Client ability to call Shell/write depends on its actual product entitlement and must be independently tested. |
| Device / execution identity | One initial Linux/WSL2 device, executing as the user's ordinary login account without implicit sudo/root. Native Windows executor is out of initial scope. |
| Tool catalog / local policy | Target complete *applicable* version-pinned upstream tool inventory; reads generally automatic, routine project writes policy-scoped, sensitive actions additionally gated. Available tools are not automatically authorized. |
| Execution scope | The ordinary OS account's actual file, process, network, credential and WSL Windows-mount access. A directory allowlist is not a Shell sandbox. |
| VPC/private connectivity | Worker binding to exact private host:port through Cloudflare Tunnel; transport privacy only, never client authorization or local consent. |
| Device credential | Separately revocable Worker-to-adapter identity distinct from public OAuth and action approval. |
| Local approval | Independent device UI/CLI approval bound to device, exact operation digest, nonce and bounded TTL; fail closed if offline, unavailable, expired or replayed. Client dialog alone is not local approval. |
| Shell launch and stdin | Each new arbitrary Shell launch gets separate local approval. Command-affecting interactive input needs its own approval or explicit time-limited, scope-limited session grant; initial approval is not perpetual stdin authority. |
| Revocation | Blocks new operation dispatch and new stdin immediately. Existing managed processes may continue and require separate explicitly approved local stop. No promise to terminate arbitrary host PIDs. |
| Execution receipt/session | Stable local IDs and queued/running/completed/failed/unknown statuses; reconcile after disconnect, never blindly repeat commands/writes after ambiguous outcomes. |
| File transfer | Quota-bound chunks with integrity checking and bounded control messages; logs/results paginated, with measured numeric thresholds still to be specified. |
| Audit | Local bounded metadata (ID/hash, tool class, approval, timestamps, outcome, sanitized error), default proposed 7-day configurable retention; no raw secret/stdout/file payload in cloud by default. |
| Hosted acceptance | Independently verified real VPC Service + Tunnel + Worker binding + Linux/WSL2 + policy negatives + compatible MCP client; ChatGPT plan permission is separate. |

## Settled decisions by round

- **Round 1 Q1=C; Q2=A; Q3=A; Q4=C; Q5=A; Q6=A; Q7=A:** ordinary Linux/WSL2 account; full applicable guarded tool catalog; routine scoped writes and locally approved sensitive actions; persistent local sessions; compatible-client capabilities separately from ChatGPT; minimal audit/health/revoke.
- **Round 2 Q8=A; Q9=A; Q10=A; Q11=A; Q12=A; Q14=A; Q15=A; Q16=A:** Windows mounts/interop remain available, direct Windows path actions need distinct approval; exact-operation local approval, fresh Shell approval; stable session/operation IDs, unknown and no blind replay; bounded outputs/chunks; special gates for security config/PID/root/exfiltration; one device/local state; independent hosted/device/client acceptance.
- **Round 2 historical Q13=C** meant relying on VPC alone. **Superseded for authorization by round 3 Q17=C:** public `/mcp` OAuth, separately revocable device credential, and local sensitive action approval remain mandatory. Private VPC is routing only. #172's prior authentication decision remains consistent.
- **Round 3 Q18=A; Q19=A; Q20=A; Q21=A; Q22=A; Q23=A:** interactive stdin separately approved or constrained by time-limited grant; revoke new calls/input but do not automatically kill existing managed processes; bounded expiring nonce-bound approval; bounded local metadata retention (7 days proposed default); truthful disclosure of approved Shell's indirect Windows access and optional OS-constrained mode; real hosted private testing only via independently authorized nonpublic/authenticated ingress, never public unauthenticated probe.

## Still open — engineering measurements, not user-choice conflicts

1. Actual VPC account Create/Bind permission, private Tunnel/Service provisioning and real cloudflared/adapter reachability; existing read-only account query showed zero Services and both legacy tunnels down.
2. Concrete OAuth discovery/version/refresh and revocation verification, exact device credential storage/rotation and local approval nonce implementation; replay and time-of-check/time-of-use negatives.
3. Pin and inventory actual Desktop Commander tool schemas, classify sensitive paths/process/config/network operations and design a non-bypassable policy boundary. Ordinary-account Shell may indirectly reach Windows resources even with direct file-tool checks.
4. Define and measure exact CPU/time, byte/chunk/checksum, TTL, log quotas, failure recovery, process ownership and termination behavior; validate on actual Linux/WSL2.
5. Check OAuth/Portal and supported client version; actual ChatGPT availability/permissions cannot be inferred from server CI.
6. Compare measured VPC transport with historical DO/WebSocket proof. Final architecture is NOT selected until hosted verification.

**Freeze:** Keep old #177/#179 closed/unmerged and their read-only evidence historical. No new high-privilege deployment, merge, production binding/secret change or to-spec before evidence gates.
