# Remote Control v2 Linux Installer (T09 · #55)

**Status: Draft PR #58 only. These instructions do not authorize a real-host installation or production cutover.** v1 Remote Control Agent and its Cloudflare Tunnel are separate, unchanged services.

## Prerequisites

- Linux systemd user manager. Install under a non-root Linux account. The installer will not invoke sudo or enable lingering.
- Node.js **24.x**, a C11-capable **cc** compiler, systemd-analyze, systemctl, and /usr/bin/test. The existing Linux pidfd session supervisor is compiled locally **before pairing or enabling any service**; no precompiled helper is downloaded.
- A trusted, reviewed, persistent checkout of lirtual/mcp-workers, with filesystem paths without spaces/systemd escapes. The script does not perform curl-pipe-shell, clone repositories, or silently update code.
- An approved and reachable HTTPS *origin* of a separately authorized v2-capable Worker; a Portal Bearer, Cloudflare API key, v1 device token, or Tunnel credential is NOT used or copied to the new host.

From the checkout, the **single installer invocation** is:

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --endpoint https://APPROVED-V2-WORKER/ --name linux-workstation

This requires a TTY. After dependency checks, it writes an Ed25519 key to the owner-controlled directory under ~/.local/share/mcp-workers/remote-control/, with mode 0600 and parent mode 0700, and displays only a short-lived **10-character one-use code in the default local interactive terminal**. For optional extra visual verification, pass `--show-fingerprint` to the original first-install invocation to show the local public-key fingerprint (first 12 bytes of SHA-256 over Ed25519 SPKI DER) and compare it with `pairing_lookup`. No separate `openssl` command or second terminal is needed. This optional comparison may help catch approval of an unintended host; MCP-side key matching alone does not prove physical-host identity. Avoid recording the pairing code/confirmation challenge or sending them to logs.

## Independent human authorization

1. In the authenticated MCP/ChatGPT connection, use **pairing_lookup** with the local code; MCP receives the device label and immutable public-key fingerprint and uses that returned fingerprint for **pairing_prepare**. The owner verifies the device context and must approve entering the challenge on the **intended** terminal. For higher-risk enrollments, use installer `--show-fingerprint` to visually compare the local fingerprint; model-side matching alone is not proof of the intended host.
2. Invoke **pairing_prepare** to obtain the separate short-lived **12-character challenge**. This tool cannot approve the device by itself.
3. Return to the *new device's terminal* and enter **only the 12-character challenge**. The installer already retains the original 10-character code in process memory, so retyping it would add no security. The new host signs the challenge together with the original code verifier using its private key. Only successful confirmation writes its server-provided device ID locally and enables an independent **remote-control-v2-agent.service** user unit.

First pairing cannot run headlessly. The installer permits up to three local re-entries for **malformed challenge format**, without submitting malformed values to the server. A valid-format rejected/expired/unknown-outcome challenge fails closed: no blind confirmation replay. **Rerunning the exact original installer command is now supported**: it first asks the server to recover any already-approved identity using its existing Ed25519 key, so an HTTP 200 received before a local crash does not strand an approved device. When the server definitively returns **404 (no approved identity)**, a new pending code is generated **using the SAME protected private key**, and older pending codes/challenges bound to that key are invalidated by the updated v2 DO. A server-side existing/revoked-key tombstone blocks pending renewal (409) without touching the local key. If a complete old local key and device ID already exist, the same **operator-invoked interactive install command** checks signed approval; on an explicit permanent denial it additionally requires a signed exact-ID/key `revoked` tombstone before entering fresh-key pairing. A 404 denial by itself never rotates keys. No existing private key or `.device-id` is deleted or overwritten automatically; network outages, ambiguous 401/403 or unverified revocation, and local identity mismatch fail closed and retain local files. Never treat local service running as proof of cloud authorization. The 10-character pending code lasts ten minutes. The private key and device ID are **never included in the systemd unit**; only their local pathname and the public HTTPS origin appear there.

The new service runs **src/v2-main.ts** under Node 24, with readOnly=true, writeFile=false and shell=false. It uses only outbound signed HTTPS/WSS; no local loopback port, v1 credential, cloudflared process, or new systemd root service is started. Normal network failures use the Agent's bounded WSS reconnect. Explicit permanent authorization denial stops reconnection; Restart=on-failure with a 15-second delay does not hammer 1008 policy rejections. Neither the installer nor the unit changes systemd lingering. On WSL2 a stopped distro cannot be woken by its systemd user manager; see #56.

Check status with:

    systemctl --user is-active remote-control-v2-agent.service
    systemctl --user status remote-control-v2-agent.service

An active service alone is **not** acceptance. Independently verify **list_devices** reports the new device as online and an approved nonsensitive **read_file** with explicit device_id succeeds. During disconnection new requests must fail closed.

## Recover, upgrade, uninstall

If local confirmation succeeded but activating the user service failed, the original paired key and ID remain. **Rerun the same installer command**: it recovers the matching identity and installs the missing v2 service. The legacy explicit `--resume` remains available for an already confirmed local identity:

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --resume --endpoint https://APPROVED-V2-WORKER/

To explicitly upgrade an already installed, owned v2 unit from an independently reviewed checkout, rebuilding the helper and verifying the new unit before cutover:

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --upgrade --endpoint https://APPROVED-V2-WORKER/

On activation failure, the installer restores the previous v2 systemd unit; no v1 unit is edited. If the source checkout becomes unavailable or the new binary is broken, stop the *v2 unit only* and inspect sanitized local diagnostics before further attempts.

Remove just the **v2 unit** (does not require a working C compiler):

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --uninstall

Uninstall deliberately retains the paired private key and server-issued device ID. If permanently retiring a device, **revoke_device({device_id}) via authenticated MCP separately**. A revoked device's old key stays permanently blocked and cannot use the automatic interrupted-pairing recovery to re-enroll. **Rejoining after revoke requires an owner-approved NEW key and NEW device ID, never unattended Agent/systemd retry.** Only rerunning the local interactive installer can detect signed revocation and begin fresh pairing. The previous identity remains unchanged until the new MCP challenge is manually approved and signed in the local terminal; never delete the old identity in an attempt to force enrollment. Deleting local files alone cannot revoke server-side access. The installer refuses to overwrite a service without its own generated marker and will never stop **remote-control-agent.service** (v1) or **remote-control-tunnel.service**.

Only sanitized state names are written to the service journal, never private key, enrollment code, local terminal challenge or command data. No service-specific environment secret file is needed. Normal Unix same-user/root file access still applies.


### One install command: initial, resume, or owner-approved replacement

**After `revoke_device` is confirmed in authenticated MCP**, run the *same regular install command on the intended local terminal*:

    node --experimental-strip-types apps/remote-control-agent/scripts/install-v2.mjs --endpoint https://APPROVED-V2-WORKER/ --name linux-workstation

- A device with an intact **approved** key/ID remains unchanged, even if the managed v2 systemd service already exists. A missing service can be reinstalled with the same identity. A pending initial pairing without a device ID uses its **existing** private key and generates a fresh 10-character code only after the server returns a definitive unapproved-key 404.
- For an existing key and device ID, a permanent approval failure is **not sufficient** to rotate identity. The installer uses the existing Ed25519 key to send a short-lived **signed read-only proof** to `/agent/re-pair/status`; the DO verifies the **exact old device ID and public key** and returns `revoked` only for an immutable tombstone. All network ambiguity, wrong keys, wrong IDs, 401/403/404 from this probe, unexpected response, or invalid files fail closed, preserving the existing identity. No automatic re-pair takes place inside the Agent or a systemd reconnect.
- When revocation is independently proven, the interactive installer **directly** starts staged fresh-key pairing; it does **not** require a `--re-pair` flag or a duplicate `RE-PAIR` text prompt. MCP owner review and a **human-entered 12-character one-time confirmation challenge on the new device** are still mandatory. A 10-character pending code is shown, without a local fingerprint unless `--show-fingerprint` was requested. The signed challenge is the actual authorization: the tombstone alone never grants a replacement device.
- Until the **new** device is approved, the old revoked key and ID remain intact and the new key/ID live in separate owner-only staging files; interruption permits retrying the same install command. Only after new approval does the installer stop its **owned v2** service, archive the old identity under `revoked-<old-device-id>`, promote the staged pair and restart the v2 unit. Same human label is permitted; device ID is always fresh. File-rename exceptions attempt rollback, but OS crash during promotion still needs manual reconciliation.
- If the operator did **not** invoke the installer locally, none of this enrollment flow may start. Ordinary WSS reconnection, systemd automatic restarts, polling, or a boot process do **not** create a new identity. The previous v1 Agent/tunnel and other v2 devices are never touched. A prior Preview Worker lacking this signed endpoint fails closed; the running production Worker is not affected by this procedure.

## Real-host acceptance still needed

Before closing #55, obtain separately authorized nonproduction evidence from a clean Linux host: wrong Node/compiler/user-bus fails before pairing, key ownership/modes, one-use code + separate local terminal challenge (optional fingerprint review), signed WSS first read, stop/start/reboot-session reconnect, approved-installed no-op, signed-revoked automatic selection with terminal approval, ambiguous-status fail-closed, failure after pairing + explicit resume, upgrade/uninstall rollback and unchanged v1 services. #47/#50/#52 also require Cloudflare-hosted WSS acceptance; #57 requires five devices and 72 hours. These tests have **not** been run by merely merging code or passing mocked CI. No automatic production deployment or secret/config mutation follows from this document.


For Microsoft WSL2 installation, lifecycle caveats, and explicit manual startup after Windows reboot, see [WSL2 v2 lifecycle](./WSL2-V2-LIFECYCLE.md). The Linux installer automatically warns when it detects a WSL2 kernel; it does not register a Windows scheduled task or keep WSL running.
