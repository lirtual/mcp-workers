# Remote Control v2 Linux Installer (T09 · #55)

**Status: Draft PR #58 only. These instructions do not authorize a real-host installation or production cutover.** v1 Remote Control Agent and its Cloudflare Tunnel are separate, unchanged services.

## Prerequisites

- Linux systemd user manager. Install under a non-root Linux account. The installer will not invoke sudo or enable lingering.
- Node.js **24.x**, a C11-capable **cc** compiler, systemd-analyze, systemctl, and /usr/bin/test. The existing Linux pidfd session supervisor is compiled locally **before pairing or enabling any service**; no precompiled helper is downloaded.
- A trusted, reviewed, persistent checkout of lirtual/mcp-workers, with filesystem paths without spaces/systemd escapes. The script does not perform curl-pipe-shell, clone repositories, or silently update code.
- An approved and reachable HTTPS *origin* of a separately authorized v2-capable Worker; a Portal Bearer, Cloudflare API key, v1 device token, or Tunnel credential is NOT used or copied to the new host.

From the checkout, the **single installer invocation** is:

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --endpoint https://APPROVED-V2-WORKER/ --name linux-workstation

This requires a TTY. After dependency checks, it writes an Ed25519 key to the owner-controlled directory under ~/.local/share/mcp-workers/remote-control/, with mode 0600 and parent mode 0700, and displays a short-lived **10-character one-use code in the local interactive terminal**. Avoid recording this terminal transcript or sending it to logs.

## Independent human authorization

1. In the authenticated MCP/ChatGPT connection, use **pairing_lookup** with the local code; inspect device label and fingerprint. Compare against the intended host; labels alone are untrusted.
2. Invoke **pairing_prepare** to obtain the separate short-lived **12-character challenge**. This tool cannot approve the device by itself.
3. Return to the *new device's terminal*, repeat the original 10-character code, and enter the challenge. The new host signs the challenge with its private key. Only successful confirmation writes its server-provided device ID locally and enables an independent **remote-control-v2-agent.service** user unit.

First pairing cannot run headlessly. If confirmation fails, no service is enabled; do not retry with a different identity until the pending enrollment has been reviewed or expired. The 10-character enrollment code expires after ten minutes. The private key and device ID are **never included in the systemd unit**; only their local pathname and the public HTTPS origin appear there.

The new service runs **src/v2-main.ts** under Node 24, with readOnly=true, writeFile=false and shell=false. It uses only outbound signed HTTPS/WSS; no local loopback port, v1 credential, cloudflared process, or new systemd root service is started. Normal network failures use the Agent's bounded WSS reconnect. Explicit permanent authorization denial stops reconnection; Restart=on-failure with a 15-second delay does not hammer 1008 policy rejections. Neither the installer nor the unit changes systemd lingering. On WSL2 a stopped distro cannot be woken by its systemd user manager; see #56.

Check status with:

    systemctl --user is-active remote-control-v2-agent.service
    systemctl --user status remote-control-v2-agent.service

An active service alone is **not** acceptance. Independently verify **list_devices** reports the new device as online and an approved nonsensitive **read_file** with explicit device_id succeeds. During disconnection new requests must fail closed.

## Recover, upgrade, uninstall

If local confirmation succeeded but activating the user service failed, the original paired key and ID remain. Do **not** overwrite them: explicitly resume the install using the same checkout:

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --resume --endpoint https://APPROVED-V2-WORKER/

To explicitly upgrade an already installed, owned v2 unit from an independently reviewed checkout, rebuilding the helper and verifying the new unit before cutover:

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --upgrade --endpoint https://APPROVED-V2-WORKER/

On activation failure, the installer restores the previous v2 systemd unit; no v1 unit is edited. If the source checkout becomes unavailable or the new binary is broken, stop the *v2 unit only* and inspect sanitized local diagnostics before further attempts.

Remove just the **v2 unit** (does not require a working C compiler):

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --uninstall

Uninstall deliberately retains the paired private key and server-issued device ID. If permanently retiring a device, **revoke_device({device_id}) via authenticated MCP separately**. Deleting local files alone cannot revoke server-side access. The installer refuses to overwrite a service without its own generated marker and will never stop **remote-control-agent.service** (v1) or **remote-control-tunnel.service**.

Only sanitized state names are written to the service journal, never private key, enrollment code, local terminal challenge or command data. No service-specific environment secret file is needed. Normal Unix same-user/root file access still applies.

## Real-host acceptance still needed

Before closing #55, obtain separately authorized nonproduction evidence from a clean Linux host: wrong Node/compiler/user-bus fails before pairing, key ownership/modes, one-use code and fingerprint review + terminal challenge, signed WSS first read, stop/start/reboot-session reconnect, failure after pairing + explicit resume, upgrade/uninstall rollback and unchanged v1 services. #47/#50/#52 also require Cloudflare-hosted WSS acceptance; #57 requires five devices and 72 hours. These tests have **not** been run by merely merging code or passing mocked CI. No automatic production deployment or secret/config mutation follows from this document.


For Microsoft WSL2 installation, lifecycle caveats, and explicit manual startup after Windows reboot, see [WSL2 v2 lifecycle](./WSL2-V2-LIFECYCLE.md). The Linux installer automatically warns when it detects a WSL2 kernel; it does not register a Windows scheduled task or keep WSL running.
