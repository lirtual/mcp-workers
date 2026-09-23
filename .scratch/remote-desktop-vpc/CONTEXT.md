# Remote Desktop MCP — Domain Context (exploration only)

Domain language for [#170](https://github.com/lirtual/mcp-workers/issues/170). **Requirements agreed in grill-with-docs round 1; implementation and transport architecture are NOT approved.** No host Shell/write permission has been deployed.

| Term | Meaning |
| --- | --- |
| Remote Desktop MCP | A user-owned remote MCP that lets an authorized client request applicable local Desktop Commander operations on designated devices, subject to authorization. |
| Client | Application requesting an operation. A tool exposed by the server is not necessarily callable under a particular client's plan or permissions. |
| Device | A user-designated local execution target. Initial support is Linux or Linux running under WSL2; the Windows host is a distinct, not-yet-supported target. |
| Device executor | The local agent handling an authorized operation with the permissions of its operating-system identity. |
| Execution identity | The operating-system account whose rights the local agent inherits. The agreed initial choice is the user's ordinary Linux/WSL2 account, rather than a dedicated low-privilege identity. |
| Tool capability | A version-specific named operation and schema of the upstream local Desktop Commander, not a promise that every connected client can invoke it. |
| Tool catalog | The complete applicable upstream capability inventory for a selected version. Sensitive operations may be present but gated individually. |
| Execution scope | Resources actually reachable by the executor's account (files, processes, network and credentials). A configured project directory or command blocklist cannot constrain an unrestricted Shell. |
| Authorized project scope | A user-selected working directory or class of ordinary file operations that can be performed without per-call confirmation. This is a policy/guardrail, NOT a host security boundary for Shell. |
| Authorization | A decision about who may invoke an operation, on which device, under which scope and conditions. Private routing alone does not grant authorization. |
| Approval | A local user decision tied to a specific device and exact operation, with a short expiry. If approval is unavailable the sensitive operation is rejected; a client UI's generic confirmation is insufficient evidence. |
| Execution session | A locally held interactive or background process with an independently queryable lifetime, output and stop behavior. It may outlive one remote request. |
| Execution receipt | Stable operation identity and recorded state (including an unknown outcome) used to reconcile a request, its execution and result after retries/disconnections without blindly re-executing side effects. |
| Revocation | Removing authority for future dispatch and preventing stale credentials/results from regaining authority. A running process remains identifiable; the separate stop/terminate policy is unresolved. |
| Audit record | Bounded local metadata about an operation, approval, outcome and timing, without recording unredacted credentials or arbitrary file contents by default. |
| Private connectivity | A network path limited to approved private destinations. It is distinct from the identity of a calling client, local approval, and authority to execute a tool. |
| Client authentication | Establishing which remote client may send requests to the remote MCP; distinguish this from network privacy and local user confirmation. |
| Local approval channel | An independent on-device interface for granting or refusing specific sensitive operations; it does not implicitly grant a remote caller access to all files or processes. |
| File transfer | Bounded, resumable or chunked movement of file content with integrity and resource limits, distinct from small control requests. |
| Full-capability target | Provide the applicable upstream Shell, file read/write/edit/search, process/session, configuration and format-specific operations through approved policy; not proprietary hosted services or unconditional remote host control. |

## Settled requirements — round 1, 2026-09-23
- Personal self-hosted Cloudflare Workers remote MCP; tool execution remains local and independent from workflow-mcp-worker's production resources.
- Q1=C: ordinary Linux/WSL2 login identity with the account's real host permissions; no claim of strong isolation. Never run as root by default or silently elevate.
- Q2=A: align with upstream core catalog, while gating security configuration and system-wide process or privilege operations separately.
- Q3=A: ordinary reads automatic; configured routine project writes according to policy; sensitive Shell/destructive/privileged operations require local approval or time-limited scope.
- Q4=C: Linux/WSL2 initial target, not native Windows host execution. WSL2 and Windows have different execution and file-access boundaries.
- Q5=A: durable local sessions, bounded output, status/stop and offline/reconnect recovery.
- Q6=A: provide full-capability MCP to clients that genuinely support it; ChatGPT tools are accepted separately under actual plan permissions.
- Q7=A: minimal device health, audit, revoke and execution receipts, not a new orchestration platform.
- Local upstream is MIT-licensed; reimplementing the proprietary Remote Desktop Commander cloud backend is out of scope.

## Open boundary questions (not decisions)
Q13 trust-boundary reconciliation (client OAuth versus Worker-to-device credential and private routing); how the local verifier authenticates an approved action and protects against replay; policy for sending additional input to an already-approved interactive Shell; hard-stop and revocation semantics for running processes; defensible handling of direct Windows paths versus authorized Shell's indirect reach; concrete size/retention/timeout quotas and chunk integrity; selected upstream version/tool compatibility and real transport (#178). No automatic expansion of permissions or production deployment follows from these requirements.
