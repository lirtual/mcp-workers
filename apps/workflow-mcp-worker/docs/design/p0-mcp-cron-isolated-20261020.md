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

**Cleanup verified:** both temporary Cloudflare Workers and the throwaway D1 database were deleted. Direct account listing returned **12 Workers, 4 D1 databases and 1 Workflow**, with no `wf-p03-*` or `wf-p04-*` resources left. Both WSL temporary secret-key files were deleted. Redacted/synthetic test results remain in the isolated WSL scratch directories; no test code or secrets were committed to the PR.

**Q1–Q50 unchanged.** All code and test keys are scoped to scratch/throwaway resources. Do not claim AC-08/27 or AC-11/29 fully closed on these results.

## Real native Cron → D1 admission → Cloudflare Workflow follow-up (2026-10-20)

An additional **isolated** end-to-end PoC deployed one Cloudflare Worker `wf-p04-native-cron-20261020` with **only one** native `* * * * *` Cron Trigger, one dedicated D1 `wf-p04-native-cron-20261020` and Workflow `wf-p04-native-workflow-20261020`. D1 stored **one enabled past-due schedule**. The real `scheduled()` handler would persist a tick, atomically disable that due schedule exactly once, write a `reserved` Run, call `WF.create({id: deterministic_id})`, and the real Workflow would persist an effect row.

**Directly observed:** Wrangler deployed the Worker, Workflow binding and fixed Cron successfully. Cloudflare management API independently confirmed the Cron schedule is installed. **However, before safe teardown no native scheduled invocation occurred:** remote D1 contained zero `ticks`, zero `runs`, zero `effects`, and the schedule remained enabled. Thus **the end-to-end native Cron chain was NOT verified and must remain OPEN.** This result is inconclusive, not a failure of the workflow admission design: Cloudflare documents that a newly created Cron Trigger can take **up to 15 minutes to propagate** ([Cron Trigger docs](https://developers.cloudflare.com/workers/configuration/cron-triggers/)). No local/synthetic `/tick` invocation was substituted as evidence of genuine scheduling.

**Cleanup independently verified:** the temporary Cron Worker, Workflow and D1 were deleted successfully, with no persistent Cron Trigger left. Do not leave temporary cloud resources running only to await propagation, or claim P0-4 is complete based solely on deployment success. A future scheduled-window integration test can exercise the same minimal topology without creating another scheduling platform.

## Further P0-3 destination credentials and redirect test — 2026-10-20

**Scope:** one isolated local execution of the actual proposed gateway source under Node.js 22, contacting **two real temporary Cloudflare Workers** over HTTPS. One temporary D1 recorded received test-token *categories only*. All credentials were literal **test-only strings**, not secrets or real MCP credentials. These observations are **not** an end-to-end Cloudflare gateway Worker acceptance.

| Experiment | Observation | Verdict |
| --- | --- | --- |
| Dynamic gateway calls test target A | HTTP 200, target reports A-only test credential | PASS within tested path |
| Dynamic gateway calls test target B | HTTP 200, target reports B-only test credential | PASS within tested path |
| Test target A returns 302 redirect to target B | Gateway returns `blocked_redirect`, does not follow | PASS within tested path |
| Public target without a scoped credential grant | `blocked_no_target_grant`, no external call | PASS, proposed policy only |
| Non-HTTPS target string | `blocked_preflight`, no outbound request | PASS, proposed policy only |

Cloudflare D1 **independently confirmed** one request to A with credential category A and one to B with category B; no third request to B occurred after A's redirect. The proposed gateway used `fetch(..., {redirect:'manual'})` and scoped test credentials by **exact origin**; it never forwards the owner's Portal token. This aligns with [Cloudflare's explicit warning](https://developers.cloudflare.com/workers/runtime-apis/request/) that automatic redirects can forward **all** headers, including Authorization, even to a different host. Simple rejection of redirects is a valid fail-closed default rather than building a new proxy/rewrite mechanism.

**Limitation and tool barrier:** the attempted Cloudflare secret setup for the isolated *gateway* Worker was blocked by execution safety checks. The deployed gateway had **no** `PROBE_KEY` and rejected all ingress. Rather than bypass that check, the **same transpiled gateway source** was executed locally with an in-memory test key and the real Cloudflare target Workers. These results do **not** demonstrate Cloudflare edge runtime egress correctness for this gateway. No actual private, metadata, loopback or DNS-rebinding traffic was sent; comprehensive SSRF and DNS/redirect-proof egress controls remain **OPEN**. The test code's hostname checks are expressly **not** sufficient for DNS rebinding defense.

**Verified teardown:** all three temporary Workers (gateway and both targets) plus the temporary D1 were deleted. Cloudflare resource counts returned to **12 Workers, 4 D1, 1 Workflow**, with no named test resources left. No new long-lived token, proxy, durable record or production permission is justified by these limited tests.

## Follow-up P0-3 selection gate — 2026-10-21 (offline only)

**Scope:** Owner approved continued P0-3 validation without merging or deploying. This pass changed no runtime source, existing Worker, D1, credentials, production setting or Ticket. Q7 (dynamic targets without preregistration) and Q16 (block private/metadata/redirect/DNS bypass) remain binding.

### Reused evidence and results

- Reused the original local gateway PoC at /tmp/wf-p03-egress-20261020/gateway.mjs (SHA256 c876fd5ffac4a15651ece364e6fbbb5cb751be34de4167ef58cee69dc88a9319) with Node 22 and an in-memory fetch mock. No new proxy/SDK installation, no real network request.
- **19/19 offline assertions PASS:** unauthorized/method gate (2); HTTP/localhost/IPv4/IPv6/numeric alias/metadata/RFC1918/userinfo/custom port/dotless hostname rejections (10); non-granted public name rejected (1); target-origin-scoped synthetic A/B authorization (2); redirect from A to B, loopback or metadata target rejected without following (3); one simulated DNS-rebinding limitation case (1). Actual external traffic: **zero**.
- A chosen real public, read-only Streamable HTTP endpoint (DeepWiki MCP) was **not tested** because its remote execution request was blocked by environment safety checks. We did not retry via another route. Previously documented official SDK edge tests retain only their original narrower scope.
- **Negative evidence:** the original PoC performs hostname/URL preflight but does not validate the actual connected peer IP. With a synthetic public-looking approved name whose hypothetical DNS moves to RFC1918, the mock still sees a fetch attempt. This is **a missing policy proof**, not an observed Cloudflare SSRF exploit or a test of actual DNS behavior.

### Platform constraints and alternative selection

- [Cloudflare Request redirect guidance](https://developers.cloudflare.com/workers/runtime-apis/request/) explicitly warns that auto-following a Worker-created request may forward Authorization to another origin. Keep manual redirect handling with outright rejection; do not add an automatic cross-target redirect path.
- [Workers node:dns](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/) offers resolution, but a separate DNS lookup and subsequent fetch **do not demonstrate a pinned validated peer**. No claim of rebinding defense from preflight-only checks.
- [Request resolveOverride](https://developers.cloudflare.com/workers/runtime-apis/request/) works only under same-zone restrictions; it is not a general arbitrary-target IP-pinning API.
- [global_fetch_strictly_public](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) concerns Worker/zone routing; no documentation retrieved proves it alone enforces the full SSRF exclusion policy for dynamic hostnames.
- [Cloudflare sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) may reject private/localhost TCP peers but replacing supported Streamable HTTP fetch with a handcrafted TLS/HTTP/SDK implementation adds disproportionate compatibility, monitoring and maintenance obligations without a failing production invariant.

| Choice | Evidence | Decision and cost |
| --- | --- | --- |
| A. Existing Worker fetch + manual redirect + concrete target/tool grant | Redirect and credential isolation confirmed in local mocks/earlier limited live targets; DNS-peer invariant unproven | Keep as candidate, **not permission to enable dynamic S2** |
| B. Reuse a documented Worker-native destination enforcement primitive | No currently proven connect-time guarantee for arbitrary user-selected hostname | First verify platform contract and real isolated edge behavior; minimal dependency if supported |
| C. Separate outbound proxy, DNS pinning service, or raw socket/TLS client | Necessity not demonstrated | **Reject for now**: new secret lifecycle, operations, deployment and drift costs |

**Decision: P0-3 remains OPEN; dynamic external S2 MCP is disabled.** S1 fixed-echo edge success does not close the network boundary. No reason to create new infrastructure or to restore static preregistration requirements.

**Next falsifiable experiment only with separate isolated Cloudflare test authorization:** verify a real public read-only MCP SDK handshake and destination enforcement at connection time against controlled, non-sensitive, test-owned DNS/redirect endpoints. Do not probe unowned private hosts or cloud metadata and do not conflate Cloudflare simulation with edge enforcement. Tear down any authorized temporary resources.

**Stop condition:** if official platform capability plus safe edge evidence cannot establish Q16 for dynamic endpoints, return to the product/architecture selection gate; do not continue piling on proxy or compatibility layers, and do not merge/deploy.

## Follow-up P0-3 Cloudflare-native network egress option — 2026-10-21

**Finding (revises earlier candidate priority, not Q decisions):** Cloudflare's June 5, 2026 native Workers VPC Network supports account-wide cf1:network binding for **public Internet egress through Cloudflare Gateway**. The Worker calls env.EGRESS.fetch; Gateway matching DNS, HTTP and Network policies apply, including **Destination IP CIDR** rules. This is a simpler *candidate* than creating a dedicated egress proxy. Sources: [Workers VPC Network](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/), [June 5 announcement](https://developers.cloudflare.com/changelog/post/2026-06-05-gateway-egress/), [Gateway Network Policies](https://developers.cloudflare.com/cloudflare-one/traffic-controls/network-policies/).

### Evidence and strict limitations

- Existing WSL Wrangler **4.130.0** accepted throwaway VPC Network config with binding=EGRESS, network_id=cf1:network, remote=true. **deploy --dry-run PASS** printed env.EGRESS (cf1:network) VPC Network. Nothing was deployed; account entitlement, policies, roles and Gateway logs were not checked. A local dry-run is **not** proof that Gateway blocks a private peer.
- VPC Networks may **also reach private Cloudflare Tunnel/Mesh/subnet routes**. Merely adding the binding is *not* a security guard; without scoped deny policy, it could expand access to internal resources. Never edit a broad existing account rule as a test; rule order/precedence must be verified.
- An implementation calling the **global fetch** may bypass env.EGRESS.fetch. A single external HTTP transport must be enforced, including any MCP SDK-internal request path; static grep is not a complete runtime proof.
- Gateway offers destination-IP policies, but actual connection-time enforcement remains **unverified**, including Worker-specific rule targeting, policy ordering, IPv4/IPv6 ranges, DNS changes and redirects. The earlier synthetic rebinding case proves missing PoC guard, **not an observed Cloudflare exploit**.

### Minimal alternatives

| Option | Cost and proven capability | Selection |
| --- | --- | --- |
| Direct global fetch with URL preflight | Fewest app changes, but peer-address invariant unproven | Not approved for arbitrary S2 dynamic MCP |
| **Native VPC Network + Gateway** | Binding and existing platform policies; requires network rights, scoped policies, observability and possibly Zero Trust setup; no new custom proxy/token issuer | **First platform candidate** for separately authorized, safely isolated proof |
| Custom proxy, pinned-DNS service, handmade TCP/TLS HTTP stack | Added privileged service, secrets, operational lifecycle, transport incompatibility | Do not introduce without evidence native alternative is insufficient |

**Next safe proof sequence** (requires narrowly scoped authorization for any account-policy mutation and any temporary Worker deployment): read-only inspect Zero Trust availability, current policy scopes and roles; prove isolation from existing Tunnel/Mesh private routes; isolate policy to test traffic without altering other users' routing; use benign owned endpoints and logs to test allow-public/deny destination-IP and DNS-change behavior; verify every MCP SDK outbound request uses the intended transport; delete temporary rules and Workers and prove cleanup. No probes against actual private or cloud metadata services.

**Stop gate:** P0-3 is **OPEN** and S2 dynamic external MCP stays disabled until account policies and real Cloudflare edge tests uphold Q16. No new production components, endpoint preregistration requirement, extra CI, Tickets, merge or deployment are authorized by this report.

## Follow-up P0-3 account isolation gate — 2026-10-21

**Conditional user authorization:** Temporary Gateway policy + test Worker creation was approved **only if** policy isolation to test traffic could first be proven and verified not to affect existing devices, Tunnel/Mesh routes, or other Workers. **That prerequisite was not met; no Gateway policy, test Worker, network rule, secret, or live Cloudflare connection was created/changed.**

### Read-only observations (sensitive account details deliberately omitted)

- Wrangler 4.130.0 OAuth was active for the intended account and its access-scope listing **did not include a named Gateway policy read/write permission**. Existing native VPC service list contained **at least one active configured private-service target**. No service name, endpoint, tunnel ID, internal address or port is included in this public repository.
- Existing VPC Network binding can reach both public Internet through Gateway and private Cloudflare Tunnel/Mesh/subnet destinations. [VPC Networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/) documents the combined reach. Binding to cf1:network is **not itself a private-network isolation guarantee** and could widen access for a testing Worker.
- [Gateway Network policy selectors](https://developers.cloudflare.com/cloudflare-one/traffic-controls/network-policies/) document Traffic Source values for device clients, Mesh, WAN, proxies, RDP and MCP portals, but **do not document a policy predicate for a specific originating Worker name/ID**. By contrast, [2026-09-29 Network Session Logs](https://developers.cloudflare.com/changelog/product/workers-vpc/) include SourceName/SourceID for Workers VPC logging. **Log attribution does not prove that policy rules can match a Worker identity**. Do not confuse matching by destination or generic Traffic Source with policy isolation to one test Worker.
- Read-only Cloudflare connector Gateway introspection returned tool errors. The active Wrangler OAuth permission inventory did not establish Gateway policy authority. **Actual account policy list, ordering, Worker-scoped expression support and Zero Trust entitlement are UNVERIFIED.** No fallback extraction/exposure of OAuth tokens was attempted.
- Existing test-only local Wrangler deploy --dry-run succeeded in the previous evidence section, which **only** confirms the binding's build/config syntax; no new edge fetch, DNS change, metadata/private target request, or real Gateway block was tested.

### Stop decision and smallest next step

**STOP at the pre-provisioning boundary.** The conditions for safe rule scoping are unproven, and an account-wide experimental block could disrupt unrelated Cloudflare One clients and production services. User authorization was conditional; do **not** infer permission for unscoped account-wide policy creation. This is **not** proof that VPC+Gateway is incapable of meeting Q16, only that this account/test configuration is not verified safe for mutations.

Before any future account change, use authorized **read-only** Gateway policy access to prove a real per-test-Worker predicate (not just a log field), verify rule precedence and any active private routes, and show the policy affects neither existing Worker VPC flows nor user/device traffic. If that cannot be established, consider a **separately isolated Zero Trust test account** or return to the owner for architecture selection; do not silently deploy an egress proxy or weaken SSRF requirements.

**P0-3 remains OPEN; S2 dynamic target invocations remain disabled.** No extra CI, tickets, code, dependencies, merge or production deployment were made in this verification.
