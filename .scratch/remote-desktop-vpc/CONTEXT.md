# Remote Desktop MCP — Domain Context (exploration only)

This domain dictionary captures the clarified product intent for #170. It is **not an approved implementation specification**, a production authorization, or evidence of host Shell/write availability.

| Term | Meaning |
| --- | --- |
| Remote Desktop MCP | User-owned remote MCP capability that lets an authorized client request operations on the user's own Windows/Linux device. Its goal is to provide the local Desktop Commander tool capabilities, subject to separately enforced permissions. |
| Client | The application asking the remote MCP to perform a tool operation. Client support and entitlement can vary; server availability is not evidence of client execution permission. |
| Device | A personally owned Windows/Linux machine designated by the user as a remote execution target. |
| Device executor | The authorized local operating context that runs tools with the access of its own operating-system identity. It is distinct from the remote client and cloud-facing MCP server. |
| Tool capability | A named operation of the chosen upstream Desktop Commander version, such as reading/writing files or starting/interacting with a process. Capability does not imply unconditional authorization. |
| Tool catalog | The version-specific list of upstream tool names, input schemas, output semantics and availability. The product aims at coverage of the real upstream catalog rather than reconstructing tools by hand. |
| Execution scope | The files, processes, network destinations and system resources accessible to a particular local execution context. Stating an allowed directory does not itself constrain arbitrary Shell commands. |
| Authorization | The decision about who may call which operation on which device and under what conditions; a private network transport is not authorization. |
| Approval | An explicit user decision on a particular sensitive action or pre-approved scope. It must not be confused with a client UI displaying a generic confirmation. |
| Execution session | A locally held interactive or background process lifetime. Calls may attach to or terminate such sessions; it can outlive a single remote request. |
| Revocation | Removing future authority to call device tools and preventing stale requests from regaining it. Handling already-running local processes is a separate policy decision. |
| Full-capability target | Aspiration to support the local upstream's complete applicable tool catalog (Shell, editing, reading/writing, search, sessions, processes, and format-specific file features) on an authorized executor. This is not a promise of unrestricted host access or of tool availability in every ChatGPT plan. |

## Settled intent
- Personal use, self-hosted remote MCP on Cloudflare Workers; execution occurs locally on the user's device.
- The **final capability target includes Shell and file writes**, not just read-only listing; the initial read-only tests remain non-privileged transport proofs.
- The repository's independent workflow-mcp-worker production resources remain outside this context.
- Remote Desktop Commander proprietary hosted service is not being reconstructed.

## Open boundary questions
Actual host versus dedicated restricted container; confirmation and session scope; privileged configuration and unrestricted PID operations; multi-device routing; version compatibility; ChatGPT versus alternate-client acceptance. These are not decisions.
