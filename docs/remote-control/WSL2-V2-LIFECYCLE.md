# Remote Control v2 — WSL2 lifecycle and recovery (T10 / #56)

**Draft-only:** This is a nonproduction validation plan. Do not install it on an existing v1 machine, change Windows startup settings or authorize production changes without a separate approval.

## Same Linux Agent, no Windows agent

Use the *same* reviewed checkout and T09 Linux user-service installer **inside the intended WSL2 distribution and its normal Linux user account**:

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --endpoint https://APPROVED-V2-WORKER/ --name my-wsl2

The installer detects the `microsoft-standard-WSL2` kernel and explains the lifecycle limitation before pairing. **WSL1 is rejected** because the Linux managed Shell supervisor expects Linux pidfd behavior. On WSL2, Node 24, cc and a working systemd user manager are still required; no Windows native Shell backend is supplied. Generate an **independent local Ed25519 identity** for *each* intended distribution/installation; do not copy another host's `v2-identity.pem` or `.device-id`. Keep the identity under the WSL distro's Linux home filesystem (not `/mnt/c` or other Windows-mounted paths). The private directory/file permissions remain 0700/0600.

The same two independent confirmation steps apply: 10-character locally displayed code, authenticated MCP lookup and fingerprint review plus `pairing_prepare`, then original code + 12-character challenge entered by a human in the **new WSL2 terminal**. No remote Portal Bearer or Cloudflare secret is stored in the distro.

## systemd user service is not Windows startup

Microsoft documents explicitly that **systemd services do not keep a WSL instance alive**. This means that even an enabled `remote-control-v2-agent.service` **cannot** wake a stopped distro, and Windows boot does not establish that WSL2 or its user systemd manager started. Do not claim “always online”, do not silently create a Windows Scheduled Task, Windows service, startup item or native Windows Agent. A Windows host can be running while this WSL2 device must correctly appear **offline** to MCP once the socket loss is observed. A briefly stale TCP/WebSocket may need transport timeout to be detected; the Cloudflare DO does not infer physical host power state. An offline operation must fail closed with no execution/queue. Reconnection obtains a fresh signed nonce and a new epoch; mutation `operation_id` is never replayed automatically.

**Microsoft references:**
- https://learn.microsoft.com/en-us/windows/wsl/systemd
- https://learn.microsoft.com/en-us/windows/wsl/basic-commands
- https://learn.microsoft.com/en-us/windows/wsl/wsl-config

## Operator-initiated startup and recovery

From **Windows PowerShell**, first inspect known distribution names and WSL versions:

    wsl.exe --list --verbose

Confirm the target's VERSION is **2**. To manually launch the intended distribution after Windows reboot or a deliberate distro shutdown (replace values with verified names):

    wsl.exe --distribution Ubuntu --user your-linux-user

This opens that user's Linux shell. **Inside WSL2**, check systemd availability and the *independent v2 unit*:

    systemctl --user status remote-control-v2-agent.service
    systemctl --user is-enabled remote-control-v2-agent.service
    systemctl --user start remote-control-v2-agent.service
    systemctl --user is-active remote-control-v2-agent.service

When WSL2 systemd is not enabled, update the **WSL distro's** `/etc/wsl.conf` only after separate host authorization, set `[boot]` with `systemd=true`, and restart the distro using Microsoft's documented procedure. The installer itself never edits `wsl.conf`, calls `wsl.exe --shutdown`, changes linger, or toggles Windows startup. If the user manager still cannot be reached, resolve it as an operator precondition; do not run an unmanaged duplicate Agent or copy a v1 credential.

For each restart, independently check the authenticated MCP `list_devices` for the **same opaque device_id** and verify a nonsensitive explicit-device read. The unit's “active” state alone is insufficient to prove authenticated WSS connectivity. If the distro is stopped (or WSS has timed out), the device should report **offline**; an unrelated Linux/WSL device should remain online. **Never** retry an uncertain Shell/write with a fresh ID to force completion; query the local receipt once reconnected.

To stop a particular distro *only during separately approved test downtime*:

    wsl.exe --terminate Ubuntu

This affects the entire named distribution and any applications within it, not just the v2 Agent. **Do not execute this command on a production WSL machine as part of this documentation.** After a deliberate stop, manually start the distro with the command above. Windows reboot is a separate manual test and cannot be simulated by a unit test.

## Required real-host acceptance before closing #56

1. In a newly provisioned WSL2 distro, verify Node 24, compiler, systemd, owner-only key, 10-character pairing, independent confirmation and first read using one unique `device_id`.
2. Stop **only a separately authorized disposable test distro**, observe actual socket loss and eventual offline status; new reads and operations fail closed and unrelated device sessions remain unaffected.
3. Relaunch distro manually, verify v2 user unit is running, new signed WSS epoch and *same* device identity; no automatic replay. Deliberately restart v2 user unit and repeat.
4. With explicit host authorization, reboot the Windows test machine; observe whether WSL auto-started **rather than assuming it did**. If stopped, the recovery procedure above must work. Test Windows guest logout/user-manager session boundaries separately.
5. Confirm `--resume`/`--upgrade`/`--uninstall` target only `remote-control-v2-agent.service`; existing v1 Agent/Tunnel and all Cloudflare production resources remain unchanged.

**Not complete:** This draft is documentation, WSL2 kernel checks and mocked socket-state tests, **not** actual Windows reboot, distribution termination or Cloudflare-hosted pairing evidence. No Windows scheduler, native Agent, new CI workflow, deployment, secret or Tunnel mutation is added.
