# Remote Control MCP — context

Remote Control is a single-owner MCP Worker backed by a signed per-device WebSocket relay and native Agent. The Worker owns authenticated ingress, device grants and routing; the bundled Agent under `apps/remote-control-mcp-worker/agent` executes authorized local file, search, Shell and Agent-owned managed-session operations on Windows, Linux/WSL2 or macOS. Browser GUI operations are owned by the independent Browser MCP and are not RCA tools.

**Identity and permission**

- Browser pairing (#1018, staged rollout) authenticates the fixed Clerk Owner with a short-lived standard Session JWT, then requires explicit review and approval of the pending identity and grant type. It shares the existing coordinator with MCP pairing; login is not device authority. Clerk failure is scoped to this entry. The old MCP tools remain until real-device and production acceptance. After Worker-first publication and a compatible Agent release, the canonical installer prints the browser link with a fragment and the local key fingerprint. The local grant selection and signed identity claim are unchanged. Noncanonical endpoints must not send their pending code to the canonical origin; the existing owner flow remains available during transition.
- Pairing requires an explicit Owner grant tied to a device identity. A temporary grant is bounded and nonrenewable; permanent grants retain independent revocation and online/idle rules. Neither installation nor a valid MCP token alone grants a device.
- GitHub-hosted temporary Session devices require independent Workflow physical Attempt authorization; an approved personal device is not a substitute for a Session grant.
- The Agent's OS account and host permission model remain authoritative. Native process ownership, session stops, device revocation and receipts must fail closed when identity cannot be verified.

**Effects and recovery**

- Mutating requests have stable operation identities and local receipts. An Unknown response is not permission to retry an external effect; reconcile the original operation before continuing.
- A cancellation or Worker acknowledgment does not itself prove physical job or subprocess termination. Distinguish Agent-managed session, actual OS process, GitHub job and temporary device cleanup.
- Installation, Agent Release publication, Worker publication, native upgrade, pairing and production acceptance are separate operations. An upgrade must preserve identity and historical receipts; an unknown or unsafe upgrade must not silently re-pair or discard history.
- Distributing public installers does not authorize pairing. Artifact integrity checks are not independent proof of production deployment or physical-device acceptance.

**Accepted lifecycle design — not yet delivered (#1035)**

- [Spec #1035](https://github.com/lirtual/mcp-workers/issues/1035) unifies RCA public management across Linux/Windows Rust and current macOS Node, not platform executors. Remove fixed human confirmation words, not identity or high-risk authorization. Pairing follows #1018 independent acceptance and retirement gates.
- Automatic Update Policy is local to permanent Standard installs: disclose default enabled on new installs, explicit migration consent on existing installs, support disabling. Only eligible Owner-ON stable devices update from official Immutable Stable Latest, at bounded low frequency and safe idle cutover. No temporary/Workflow Session automatic update, downgrade, forced termination, automatic re-pair or STOP bypass. Release and Worker publication remain independently authorized.
- Upgrade Transaction reuses staging, lifecycle lock, Freeze, independent execution and recovery. Preserve identity and receipts. Isolate updating failures; historical Unknown alone does not block if execution risk is independently isolated and receipts safe; never replay. Dispatch and process state do not prove signed connection or actual service recovery.
- Normal Restart preserves Owner-ON intent, unlike Stop followed by Resume. Uninstall, revocation and identity purge are distinct; ordinary uninstall preserves identity and necessary receipts. Status/doctor are read-only; local facts remain available during update/authentication outages; remote tooling resolves exact device identity.
- No new service, permanent updater, cloud policy store or parallel lifecycle system. #911/#912 and macOS Rust migration are out of scope. This is frozen design, not supported runtime behavior before acceptance.

The executable implementation, tests, [Agent skill](../../apps/remote-control-mcp-worker/skills/remote-control/SKILL.md), existing release gates and reviewed GitHub Issues are authoritative for current details. High-impact rationale still relevant to implementation is retained in selected ADRs; completed migration and version acceptance logs remain in Git/Issues.
