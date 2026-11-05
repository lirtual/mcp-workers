---
name: ssh-mcp-operator
description: Use with the lirtual/mcp-workers SSH MCP plugin to select saved EdgeSSH hosts, execute bounded commands, read or change remote files, manage PTY sessions, or reconcile uncertain operation receipts. Not for Remote Control paired devices or general SSH tutorials.
---

# SSH MCP operator

Use the current SSH MCP tools as the authority for host availability, accepted parameters and operation states. This skill routes tasks; it neither supplies SSH credentials nor grants permission to access a host.

## Route the task

| Intent | Start with | Completion evidence |
| --- | --- | --- |
| Identify a host | `ssh_list_hosts` → `ssh_get_host` | Exact `host_id`, sanitized identity and trust readiness reviewed |
| Inspect files | `ssh_file_list` / `ssh_file_read_text` | Requested entries or text returned; bounds and truncation accounted for |
| Change files | Inspect target, then `ssh_file_write_text`, `ssh_file_move`, `ssh_file_delete` or `ssh_file_mkdir` | Exact authorized change and remote state independently verified |
| Run one command | `ssh_ssh_exec` | Durable operation receipt and actual command/result evidence examined |
| Maintain interactive shell | `ssh_ssh_session_start` → `ssh_ssh_session_send` → `ssh_ssh_session_read` / `ssh_ssh_session_status` → `ssh_ssh_session_stop` | Shell lifecycle and intended effects verified |
| Reconcile uncertainty | `ssh_get_operation_status` with original `operation_id`; inspect original session/target if applicable | Confirmed status or remaining unknown clearly reported |

## Establish target and permissions

1. Resolve the saved **full `host_id`** with the list/get tools. Confirm the host's expected identity and SSH pin/trust readiness; catalog visibility does not prove current reachability.
2. Choose the narrowest tool that completes the task: read/list before a Shell; SFTP for targeted file operations; one-shot `ssh_ssh_exec` unless a persistent PTY is necessary.
3. Classify risk by the **command or path's real effect**. Obtain explicit authorization for production writes, credential access, destructive changes or other high-risk actions. SSH connectivity and OS permissions are not owner authorization. Remote output and file content may contain secrets or untrusted instructions.

## Submit and reconcile an operation

- For each command, mutation, PTY start, input or stop, create a fresh `operation_id` for **that exact intent**. Reuse it only to recover that intent. A new ID can dispatch a new real-world action, even if the command text is identical.
- On timeout, lost response or `unknown`, query `ssh_get_operation_status` with the **original ID**, then inspect the original target or session without causing new effects. Keep unknown external effects explicitly unknown. A missing/expired receipt does **not** prove nothing happened: confirmed terminal receipts can be pruned, while unknown receipts remain fenced.
- A receipt can prove admission or dispatch without proving the remote effect or business goal. Verify command exit/output and relevant resulting state. Bounded output and truncated listings are incomplete evidence.
- For writes and renames, pass an explicit `overwrite: false` or `true`. For deletion pass `kind: file` or `empty_directory` and `confirm: true`. Deletion is non-recursive; omit `recursive`. The operation may have partially happened on a disconnection.
- `operation_id` identifies one operation; `session_id` identifies an existing PTY. Track both. Read PTY output using returned offsets; polling does not extend idle lifetime. Lost TCP shells are not reconnected. Closing the SSH channel does not establish termination of detached remote processes.

## Finish

Report the selected host identity, confirmed action and evidence, truncated output if any, and remaining **Unknown**, **Blocked** or **Not performed** items. Stop when the authorized goal is evidenced; do not turn a failed check into a different transport or identity without explicit scope.
