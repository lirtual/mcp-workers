---
name: remote-control
description: Use with the lirtual/mcp-workers Remote Control MCP plugin to inspect paired devices, read or modify their files, run OS commands and managed sessions, diagnose unknown operation receipts, or manage device pairing and revocation. RCA Browser/Computer tools are retired; use the separate BrowserMCP for Chrome/Edge extension automation.
---

# Remote Control operator

Use the current **Remote Control** MCP tools as the authority for available operations, parameter schemas, device state and receipts. This skill supplies task routing; it neither grants access nor defines a second device capability registry. Follow the user's authorization and the selected device's OS permissions.

## Route the task

| Intent | Start with | Done when |
| --- | --- | --- |
| Inspect devices | `list_devices` | The exact device identity, OS, grant and reported connection state are known |
| Read local files | `stat_file`, `list_directory`, `read_file` / `read_files`, or `search_files` | Requested contents or metadata are obtained; pagination and truncation are accounted for |
| Change files | Read current path and content, then `write_file`, `replace_text`, `move_file`, `create_directory` or `delete_file` | The exact authorized change and its final receipt are independently checked |
| Run or inspect a command | `run_command` → `read_session_output` / `list_sessions` | Command exit, bounded output, and intended resulting state are verified |
| Diagnose uncertain work | `get_operation_status` with the original ID; inspect an existing session if present | The operation's confirmed state and remaining uncertainty are reported |
| Pair or revoke | Use the current official Agent installer. The Owner opens the Agent authorization link and explicitly confirms its fingerprint and grant. MCP pairing tools are retired. Use `list_devices` for existing grants/revocation. | Exact device key/ID, grant and resulting cloud state are verified |

**Retired GUI boundary:** Spec #628 removed RCA-owned Browser/Computer MCP tools from production discovery and execution. Cached ChatGPT tool definitions are not evidence of current support; do not invoke them. For browser control use the independently authorized BrowserMCP Profile. RCA Shell still runs with the selected OS user's permissions; removing GUI-specific MCP tools does not sandbox Shell.

## Establish the target

1. Select a **connected account** using its supported `link_id`. If multiple accounts could satisfy a write and user intent does not identify one, ask for the account. Treat a missing or unauthorized connection as a blocker, not permission to switch accounts.
2. Use `list_devices` to resolve the intended **full `device_id`**. Names can repeat; match the user's exact identity and check online/offline status, grant type, reported OS, architecture and Agent version when available. A recent report is not proof of current physical reachability.
3. Match the requested operation to the **tool actually exposed by this connection** and its device/platform constraints. Tool visibility and device pairing do not prove that every host supports every operation. Treat Agent/OS permission denials as real boundaries. `list_devices.capability_hints` is an advisory report from the current authenticated Agent: `unknown` (including old, offline or stale metadata) is not a denial, and `reported_enabled` never grants a device/OS permission.
4. Choose the least powerful operation that covers the requested scope: use dedicated file/read/search tools for ordinary file operations, and follow the search routing below when repository search needs more expressive or complete coverage. Reuse an existing tracked Session when appropriate. Chrome/Edge extension automation belongs to the separate BrowserMCP plugin, not Remote Control.

## Search routing

- **Known path or simple lookup:** Read known files directly. Use `search_files` for names and scoped, single literal content searches. Its pattern is a case-sensitive substring, not regex, glob or `A|B` alternatives; filename matches can include relative directory names.
- **Advanced or repository-wide content search:** When Shell is authorized on the selected device, use `run_command` with `rg` for multiple alternatives, regex, path filtering or broad code exploration. When availability is unknown, attempt `rg` directly without a separate probe; do not install it. Keep commands read-only, quote patterns and paths for the device's Shell, delimit search arguments from options, and bound the output. Default `rg` ignores hidden/ignored files; use a scope consistent with the request rather than claiming all files were searched.
- **Unavailable or incomplete search:** If `rg` is unavailable, use existing alternatives only when their coverage and matching semantics are sufficient. Do not create a new dependency or capability registry. Continue `search_next` while native search is still running or paged; its `truncated` result, skipped files and limits prevent a complete negative conclusion. Escalate to a more complete authorized method when needed; otherwise disclose the gap rather than silently weakening the query.
- **Verify results:** For command search, verify the completed session, exit code and output truncation (`rg` exit 1 means no matches; exit 2 indicates an error). Report full coverage only when supported; distinguish valid partial evidence from unknown results. Neither an empty interim page nor an incomplete scan proves absence of matches.

## Execute and reconcile

- **Reads:** Bound file search, read offsets and pages. A truncated listing or output is incomplete evidence; follow the returned cursor/offset when needed. A `search_files` page with zero matches but `status=running` or `has_more=true` is still in progress; continue using its `session_id`/cursor rather than treating it as complete. Paths are local device paths, not URLs. Check the platform's native path format.
- **Effects:** For each authorized file mutation, command start or session input, assign one stable `operation_id` to that **exact intent**. If the call times out or its outcome is uncertain, first call `get_operation_status` with the **original device/account/operation ID**. Distinguish `completed`, `failed`, `running` and `unknown`; an absent or stale receipt does not prove the action never occurred. Do not submit a fresh intent while the prior effect is unresolved.
- **Managed commands:** `run_command` starts a command under the selected Agent's OS user, not a sandbox. On Linux/macOS use the Agent's configured shell; native Windows uses its supported PowerShell path. An `operation_id` identifies the start, while `session_id` identifies the Agent-owned command session. For a running command, page `read_session_output` by its returned offset and check EOF, exit code and actual effects; `stop_session` is an explicit process-control action, not proof that unrelated descendants ended.
- **Identity actions:** Browser approval grants the reviewed identity, not unconditional Shell or write approval. `revoke_device` is a separate irreversible cloud authorization change and does not confirm all local processes stopped. Verify exact identity and user authorization before either action.

## Authorization and completion

Classify an action by its **real-world effects**, not merely its tool name. Require the user's specific authorization for production changes, sensitive credentials, irreversible deletion, pairing/revocation or other high-risk effects. Account access, online status and a local OS-user permission are not substitutes. Preserve safety checks when using Shell rather than a narrower tool. Read only task-relevant data and keep secrets out of outputs, logs and receipts.

Report the verified device/account, action attempted, operation and session state, output/result evidence, and anything **Unknown**, **Blocked**, or **Not performed**. Stop when the requested outcome is evidenced; do not claim a requested stop, invocation acknowledgment or transport success establishes physical/business completion.
