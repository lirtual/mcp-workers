# Remote Control MCP — context

Remote Control is a single-owner MCP Worker backed by a signed per-device WebSocket relay and native Agent. The Worker owns authenticated ingress, device grants and routing; the bundled Agent under `apps/remote-control-mcp-worker/agent` executes authorized local file, search, Shell and Agent-owned managed-session operations on Windows, Linux/WSL2 or macOS. Browser GUI operations are owned by the independent Browser MCP and are not RCA tools.

**Identity and permission**

- Pairing requires an explicit Owner grant tied to a device identity. A temporary grant is bounded and nonrenewable; permanent grants retain independent revocation and online/idle rules. Neither installation nor a valid MCP token alone grants a device.
- GitHub-hosted temporary Session devices require independent Workflow physical Attempt authorization; an approved personal device is not a substitute for a Session grant.
- The Agent's OS account and host permission model remain authoritative. Native process ownership, session stops, device revocation and receipts must fail closed when identity cannot be verified.

**Effects and recovery**

- Mutating requests have stable operation identities and local receipts. An Unknown response is not permission to retry an external effect; reconcile the original operation before continuing.
- A cancellation or Worker acknowledgment does not itself prove physical job or subprocess termination. Distinguish Agent-managed session, actual OS process, GitHub job and temporary device cleanup.
- Installation, Agent Release publication, Worker publication, native upgrade, pairing and production acceptance are separate operations. An upgrade must preserve identity and historical receipts; an unknown or unsafe upgrade must not silently re-pair or discard history.
- Distributing public installers does not authorize pairing. Artifact integrity checks are not independent proof of production deployment or physical-device acceptance.

The executable implementation, tests, [Agent skill](../../apps/remote-control-mcp-worker/skills/remote-control/SKILL.md), existing release gates and reviewed GitHub Issues are authoritative for current details. High-impact rationale still relevant to implementation is retained in selected ADRs; completed migration and version acceptance logs remain in Git/Issues.
