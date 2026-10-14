# Remote Control Agent / Tunnel: systemd --user (operator runbook)

Tracking: [#42](https://github.com/lirtual/mcp-workers/issues/42). These files are **examples**, not installed units. Applying them to a real host, stopping existing processes, enabling lingering, or making any other production host changes requires **separate operator authorization**. No Worker/Cloudflare change is needed.

## Scope and limits

Use two independent user services to restart the *existing* Linux Agent and the *existing* Cloudflare Tunnel after ordinary process exit, under the **same ordinary Linux account** and **same existing credentials/VPC Service**. Neither service elevates its OS privileges or creates a sandbox; the Agent retains its existing access to files, Docker socket, WSL mounts, and command execution. The two retired Worker-side Shell/file switches are **not** reintroduced.

On WSL2, systemd services **do not keep the WSL instance alive** and cannot wake a stopped distro or automatically start it on Windows boot. A future Windows-side wake-up/schedule is a different, separately authorized task. Microsoft documentation: https://learn.microsoft.com/en-us/windows/wsl/systemd/ .

## Preflight (read-only until operator explicitly approves a cutover)

1. Confirm host identity: Linux user/UID, repo path, distro, PID 1 = systemd, and `systemctl --user` availability. The previous checked environment was `ray` (UID 1000) and repo `/home/ray/codespace/mcp-workers`; **do not assume these are still correct**. Inspect `loginctl show-user "$USER" -p Linger`; do not toggle lingering without separate approval.
2. Resolve actual absolute paths with `command -v node`, `node --version` (**must be Node.js 24** for this Agent), and `command -v cloudflared`. A prior read-only check found `/usr/bin/node`, but not its version or the cloudflared executable. Confirm the intended `cloudflared` supports `tunnel run --token-file`.
3. Confirm the Agent's `apps/remote-control-agent/.build/session-supervisor` exists and is executable. It is built by the existing `pnpm --dir apps/remote-control-agent build:shell` command; **do not build or change live binaries without permission**.
4. Confirm the already-used Tunnel token-file exists at an owner-controlled path, belongs to the intended account, and is not world-readable. Do **not** print/copy its contents, put a token in an argv flag, or place credentials in the repository. Verify Agent's existing device credential comes from the approved local store; never query the device Secret from Cloudflare.
5. Identify **both currently running** standalone processes before replacement. Their verified stop mechanism matters: another Agent on `127.0.0.1:9477` or another cloudflared can cause port/connector conflicts. **Do not kill an unknown PID, start duplicates, or switch a running process without an approved window and recovery plan**.

## Installation after separate host-configuration approval

The templates are `remote-control-agent.service.example` and `remote-control-tunnel.service.example`. Copy them to the target account's `~/.config/systemd/user/` as `remote-control-agent.service` and `remote-control-tunnel.service`. **Before enabling**, replace all placeholders:

| Placeholder | Required verified value |
| --- | --- |
| `__REPO_ROOT__` | Absolute path to this checkout; no credentials |
| `__NODE_BIN__` | Absolute Node.js 24 binary |
| `__CLOUDFLARED_BIN__` | Absolute path to the installed cloudflared |
| `__EXISTING_TOKEN_FILE__` | Absolute existing Tunnel token-file path (**path only**) |

The Agent unit references `%h/.config/mcp-workers/remote-control-agent.env`: create it **on the host**, owner-owned, mode `0600`, holding `REMOTE_CONTROL_DEVICE_TOKEN` from the existing authorized local credential source; **never commit it**. Keep the directory mode `0700`. Treat the Agent's environment as accessible to the same Linux UID/root (not a secret boundary); do not print it in diagnostics. The token-file must remain private as well.

Unit settings are deliberately small: loopback host/port 127.0.0.1:9477, an existing native session-supervisor preflight, `Restart=always`, `RestartSec=15s`, user journal logging, and `WantedBy=default.target`. There is no automatic replay of unknown operations, no auto-creation of credentials, no Windows scheduler, and no extra Worker/CI job.

Validate substituted files **before activation**:

```bash
systemd-analyze --user verify "$HOME/.config/systemd/user/remote-control-agent.service" "$HOME/.config/systemd/user/remote-control-tunnel.service"
```

After operator-approved transition of the **identified** old foreground processes (with minimal interruption and no duplicate starts), perform:

```bash
systemctl --user daemon-reload
systemctl --user enable --now remote-control-agent.service
systemctl --user enable --now remote-control-tunnel.service
systemctl --user is-active remote-control-agent.service remote-control-tunnel.service
ss -ltn | grep ':9477 '
```

If the user manager does not survive logout, inspect `loginctl show-user "$USER" -p Linger`. Only if the operator separately authorizes changing it, use `sudo loginctl enable-linger "$USER"`; this may require host privileges. **Even with linger enabled, WSL may still terminate.**

## Acceptance and failure recovery

- Check both units are `active`, the Agent listens on **127.0.0.1:9477 only**, Cloudflare's existing named Tunnel is healthy, the VPC binding and Secret **names** are unchanged, and ChatGPT Remote Control MCP can read an approved nonsensitive fixture. Tunnel healthy alone is insufficient to prove Agent health.
- Read only sanitized journal/status diagnostics: `systemctl --user status remote-control-agent.service remote-control-tunnel.service` and `journalctl --user -u remote-control-agent.service -u remote-control-tunnel.service --since '15 minutes ago' --no-pager`. Do not publish logs before screening for token/paths/output; never enable Cloudflare Invocation Logs merely for this task.
- In a *separately approved* controlled fault exercise, test an individual service crash/restart and a full user-session exit/reentry, proving the Agent/Tunnel recover and that requests **fail closed** while one is down. Do not run destructive commands or replay an uncertain receipt. A Windows reboot or `wsl --shutdown` is not included in this contract.
- If a unit has persistent errors (wrong path, wrong credential, failed preflight), **stop the retrying unit**, inspect sanitized failure classification, correct only through the authorized secret path, and test again. `Restart=always` is not a guarantee against bad credentials, unreachable networks, or WSL termination.
- Rollback after authorization: `systemctl --user disable --now remote-control-tunnel.service remote-control-agent.service`, verify no managed copies are running, restore the **previous known-good foreground invocation and credential source** as approved, and confirm Tunnel/MCP behavior. Do not rollback to an arbitrary historical Cloudflare Worker Version or rotate tokens as part of this host-service rollback.

This runbook is intentionally **not** a one-command installer. The previously used Agent/cloudflared live invocation (including absolute cloudflared binary and safe credential source) still needs operator verification before a host cutover.
