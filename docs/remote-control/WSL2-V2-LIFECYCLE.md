# Remote Control v2 — WSL2 lifecycle and recovery (T10 / #56)

**Draft-only:** This is a nonproduction validation plan. Do not install it on an existing v1 machine, change Windows startup settings or authorize production changes without a separate approval.

## Same Linux Agent, no Windows agent

Use the *same* reviewed checkout and T09 Linux user-service installer **inside the intended WSL2 distribution and its normal Linux user account**:

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --endpoint https://APPROVED-V2-WORKER/ --name my-wsl2

The installer detects the `microsoft-standard-WSL2` kernel and explains the lifecycle limitation before pairing. **WSL1 is rejected** because the Linux managed Shell supervisor expects Linux pidfd behavior. On WSL2, Node 24, cc and a working systemd user manager are still required; no Windows native Shell backend is supplied. Generate an **independent local Ed25519 identity** for *each* intended distribution/installation; do not copy another host's `v2-identity.pem` or `.device-id`. Keep the identity under the WSL distro's Linux home filesystem (not `/mnt/c` or other Windows-mounted paths). The private directory/file permissions remain 0700/0600.

The same two-code confirmation flow applies: the new WSL2 terminal displays a **10-character pairing code**; authenticated MCP `pairing_lookup` obtains the device label and immutable fingerprint and `pairing_prepare` checks that binding; the owner manually types **only the 12-character challenge** into the **new WSL2 terminal**. The original 10-character code stays in installer memory and is not re-entered. Local fingerprint display is optional with `--show-fingerprint`; MCP fingerprint consistency alone does not identify the intended physical host. No Portal Bearer or Cloudflare secret is stored in the distro.

## Independent owner-confirmation gate (T01 / #47)

For release acceptance, use a **disposable, newly paired WSL2 distribution** whose terminal, private key, and Linux user files are **not accessible to any ChatGPT/model-enabled Shell or Remote Control tool during pairing**. Do not treat an already remotely controlled WSL2 user session as an independent human channel. The owner must personally operate that distro's local PowerShell/WSL terminal when entering the challenge; asking an agent to type it invalidates this particular security test.

In the independent terminal, inspect the code and optional fingerprint, then use authenticated MCP `pairing_lookup` and `pairing_prepare` from ChatGPT. Before the owner types the one-use challenge, `list_devices` must not show the pending identity as approved; the model must not have a tool that can submit the terminal response, access the private key, or produce a signed proof on this host. Only after personal terminal confirmation should the owner check the new opaque device ID and a nonsensitive explicit-ID read. Never paste the private key, Portal token, or Agent credentials into chat. Pairing-code/challenge expiration is expected; rerun the original interactive installer command for a safe retry rather than reusing an expired challenge.

This is a **separately authorized nonproduction** host acceptance test, not a pretext for a Windows reboot, global WSL shutdown, re-pair of an existing host, or production v1 changes. Do not close #47 on cryptography-only or model-controlled terminal evidence.

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
