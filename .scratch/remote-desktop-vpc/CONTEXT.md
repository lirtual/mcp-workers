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
| Approval | An explicit local user decision or time-limited authorization for an operation. A client UI's generic confirmation is insufficient evidence of device-side approval. |
| Execution session | A locally held interactive or background process with an independently queryable lifetime, output and stop behavior. It may outlive one remote request. |
| Execution receipt | Stable operation identity and recorded state used to reconcile a request, its execution and result after retries/disconnections without blindly re-executing side effects. |
| Revocation | Removing authority for future dispatch and preventing stale credentials/results from regaining authority. Treatment of already-running processes is separately defined. |
| Audit record | Bounded local metadata about an operation, approval, outcome and timing, without recording unredacted credentials or arbitrary file contents by default. |
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
Exact approval channel, identity/renewal, session kill and revocation semantics; handling arbitrary Shell's inability to honor directory boundaries; WSL2 Windows-mounted-drive/interop reachability; operation/result size and large-file flow; multi-device scale; upstream version compatibility and transport selection (#178). No automatic expansion of permissions or production deployment follows from these requirements.
