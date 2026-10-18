> **2026-10-18 legacy upgrade compatibility (#77, Agent #3, Worker #82):**
> The published immutable **v0.1.1** Python `rca upgrade` strictly rejects the
> published **v0.1.4** Node-only archive (verified against both official assets).
> Do **not** run `rca upgrade v0.1.4 ...` on v0.1.1 or weaken the old signed
> archive allowlist. The new Agent and Worker Drafts provide an explicit,
> opt-in **`--upgrade`** migration path through the same origin-bound one-liner,
> reusing the reviewed owner-only v2 service/endpoint/key/schema checks.
> **The currently deployed v0.1.4 installer intentionally rejects this option.**
> Only after a *new immutable migration-capable Release*, reviewed Worker pin,
> owner-approved Preview deployment and disposable WSL2 validation would
> `curl -fsSL https://remote-control-v2-preview.aiyaya.workers.dev/install.sh | sh -s -- --upgrade`
> become an available command. Today this example is **NOT authorized or usable**.
> Failure rollback observed in a real Release-binary **fake-systemd fixture**;
> actual WSL2 user-systemd and signed WSS remain unverified.

> **2026-10-18 Preview protocol update (#97/#82):** The independently published immutable TEST prerelease [v0.1.4](https://github.com/lirtual/remote-control-agent/releases/tag/v0.1.4) at exact source `c389485e6570f8975346baa6bc6b0e56746824a1` replaces the old v0.1.2 **only for the new single-code-v1 Preview installer**. Reviewed x64 SHA-256: `3b3fa8c77e1c69a3e1542923eb9203c11f782b33fa96a6db832c526a4f816d4a`; ARM64: `bd9761a0cc740265aa825bd538a7a934bac4e3562f88f90507af958c3bfbafb8`. Existing v0.1.0-v0.1.3 Releases remain unchanged. The only approved Worker installer origin is `https://remote-control-v2-preview.aiyaya.workers.dev/install.sh`; it must be enabled solely with Preview flag, owner DO and MCP token. This test Release and offline CI do **not** constitute real pairing, clean-host E2E or production acceptance; #57 remains deferred.

# Standalone Agent one-command bootstrap — published v0.1.0 TEST prerelease

**Public verified prerelease:** https://github.com/lirtual/remote-control-agent/releases/tag/v0.1.0 . This GitHub Release is published, **immutable=true**, and its x64 + ARM64 official asset digests match native CI https://github.com/lirtual/remote-control-agent/actions/runs/38996153946 . Annotated tag `v0.1.0` peels to public Agent source commit `e82b90287374797ce20072ce18892055e4a17980`. The separate private Worker/v1 production deployment has not been changed.

The following pinned one-liner is **only for an isolated nonproduction test device** after the real approved HTTPS Worker endpoint is verified. Replace the illustrative origin; do NOT use an endpoint placeholder or run as root:

```sh
bash -c 'set -eu; code=$(curl -fsSL --proto =https --tlsv1.2 "https://raw.githubusercontent.com/lirtual/remote-control-agent/e82b90287374797ce20072ce18892055e4a17980/apps/remote-control-agent/scripts/bootstrap-v2.py"); exec python3 -c "$code" --tag v0.1.0 --commit e82b90287374797ce20072ce18892055e4a17980 --endpoint https://APPROVED_NONPRODUCTION_WORKER_ORIGIN/'
```

The **published** x64 installer has been tested through actual anonymous GitHub retrieval, strict archive verification/staging, bundled Node execution and a real pseudo-terminal with deliberately invalid mode: prompt displayed, no pairing performed, **zero private identity keys** created, disposable HOME removed. ARM64 native CI passed equivalent archive/CLI refusal checks but still requires actual device/owner acceptance.

All references are pinned; there is no
`latest` or `main`. Shell uses command substitution, **not** `curl|bash`,
so Python/CLI inherits the real controlling TTY for the mandatory mode/challenge
prompts. HTTP/TLS failures must abort the command (`set -e`). Python3 3.8+
and curl are **bootstrap prerequisites**; unlike the Agent, no system Node,
npm/pnpm, git or compiler is required. Python 3.12 was exercised on native
clean-host CI; other supported host distributions and the real owner pairing
still require explicit end-to-end acceptance. An immutable commit-pinned source URL is still not
independent cryptographic proof of the publisher.

The bootstrap itself fail-closes unless:
- Linux x86_64 or ARM64, non-root, kernel >=6.9, glibc >=2.28 as a base gate, an archive-specific measured `glibc_min` requirement, and TTY. Both published native binaries currently require measured glibc >=2.34.
- Public GitHub Release is published and `immutable=true`; public tag ref
  points to the exact reviewed commit; architecture-specific uploaded asset
  ID, official digest, size and fixed GitHub release URL all match.
- HTTPS redirects stay on trusted GitHub release asset hosts, download is
  bounded to 180MiB, complete SHA-256 matches official API digest.
- Archive is a bounded list of reviewed regular files/directories (not
  symlinks, traversal, devices or arbitrary paths), uncompressed entries at
  most 240MiB, includes matching manifest and ELF CPU architecture.
- Target is an owner-only version directory. On the same command replay, an
  existing program is compared byte-for-byte with a freshly downloaded
  immutable SHA-256-verified Release; mismatches fail without overwriting.
  Valid interrupted download/staging files are safely cleaned, never
  identity data or SQLite receipts. Manual upgrade remains #77.

The bundled Node24 is executed **only after** the official digest and archive
verification complete. It uses the same signed Owner MCP+local terminal
pairing flow, explicit Permanent/Temporary mode selector and read-only v2
Agent entrypoint. Permanent generates the owned v2 systemd user unit;
Temporary uses a separate protected identity and runs foreground only.
WSL2 stopped distros cannot reconnect by themselves.

**Published prerelease evidence:** public API and malicious archive cases simulated in
`tests/v2-bootstrap.test.mjs`; a genuinely built local x64 archive was
verified, safely unpacked and checked to refuse overwrite. The public v0.1.0 Release has also been independently resolved by exact tag, pinned commit, official size and SHA-256 for both assets. No real owner-approved device pairing or live service activation has been executed via this new Release.

After a cloud approval but before local `.device-id` fsync, a signed recovery
now persists the existing approved device ID with exclusive creation. An
interrupted owned systemd service activation can restart its own v2 unit;
no new grant or private key is generated. Temporary expiry never slides.

## Manual program upgrade (read-only v2 only)

The reviewed pinned bootstrap supports `--upgrade` on an already installed
permanent v2 user unit. Only immutable, owner-protected **old and new** version
directories with matching `device_protocol=2`, `receipt_schema=1` and
`upgrade_profile=read-only-no-shell-v1` are accepted. The builder enforces
literal `readOnly:true, writeFile:false, shell:false` in the v2 entrypoint.
Any Shell-enabled, checkout-based, mutable, unowned or unknown-profile
runtime is **blocked**, because Managed Session start/running/unknown state
cannot be safely inferred from SQLite alone.

For the accepted no-Shell profile, the installer reuses the existing
`installUnit()` guarded systemd unit switch. It preserves the old program
directory, Ed25519 key, device ID, endpoint, fixed temporary expiry and
operation receipts. A *definitive local unit activation failure* restores the
old owned v2 unit/program reference. Network/WSS disconnection is reported
separately and **is not** a signal to rollback or re-pair. Neither the
Python bootstrap nor the CLI touches deployed v1.

This intentionally narrow upgrade gate remains subject to isolated
clean-host, local-failure injection and real signed read-only connectivity
acceptance. Do not claim upgrades of Shell-enabled Agents as supported.

**Release publication gate completed for TEST prerelease:** immutable Release `v0.1.0` has been published with reviewed official Node 24.21.0 archive SHA-256 provenance and native x64/ARM64 clean-host CI. **Still require separate user authorization for a real device MCP pairing**, lifecycle and #57 real single-device 48 elapsed-hour acceptance, plus independent production authorization. These are not implied by CI success or prerelease publication.

## Local-only status and removal (#78)

Reviewed commit-pinned Python bootstrap also exposes --status (local program
versions, service state, public device IDs; cloud authorization, signed WSS,
read-only capability and temporary expiry always unconfirmed without owner MCP)
and --uninstall (non-root real terminal and explicit UNINSTALL-V2 confirmation).

Uninstall refuses foreign/symlinked entries, unrecognized program versions,
Shell-enabled or unknown capability profiles, foreign systemd units and
running or ownership-uncertain Agent processes. Only the installer-owned
remote-control-v2-agent.service and reviewed versioned v2 program directories
are removed. Local Ed25519 keys, device IDs and SQLite receipts are retained.
Existing v1 service, Tunnel, Cloudflare Worker and secrets are untouched.

**Local uninstall never revokes the cloud grant.** The owner must separately
call authenticated MCP revoke_device with the displayed device ID, or wait
for server-side fixed 24h expiry of a temporary grant. Offline/local service
status is not evidence of signed WSS reachability or cloud revocation.

Optional v2-only key/ID removal is separately exposed as `--purge-local-identity` after uninstall; it **never deletes shared SQLite receipt history**, requires a local confirmation and does not revoke cloud authorization. Do not improvise `rm -rf` on private state. The pinned public installer is **test-only** pending real owner pairing and 48-hour validation.

### Local activation and rollback failure-injection evidence

An isolated user-home test (`apps/remote-control-agent/tests/v2-upgrade-rollback.test.mjs`) replaces only `systemctl` and `systemd-analyze` with test-local executables on `PATH`. It covers (1) failed manual v2 activation restores the exact previous owned service definition, (2) successful v2 upgrade commits the new service definition, and (3) failed first install removes only the newly staged v2 unit. In every case, sample private key, device ID, and SQLite receipt bytes remain unchanged. This is **offline fault injection**, not live production systemd/Cloudflare WSS acceptance.

Separately, a non-root network-disabled Debian Bookworm clean-host smoke test (glibc 2.36, no system Node, Git or C compiler, read-only container root) verified an **unpublished x64 local bundle** using the Python bootstrap, safely unpacked it, started bundled Node 24.21.0, passed the native PIDFD Supervisor probe and checked the JS entry syntax. This validates one additional ABI environment beyond the build host (glibc 2.39); **it does not claim a live GitHub Release or signed owner pairing**, and does not substitute for native ARM64 acceptance.

### Active Agent uninstall refusal

The local program removal guard now verifies `/proc/<pid>/exe` and the process working directory alongside the argument vector, because a running Agent may rewrite/hide its command line. Exited zombies do not count as running; unreadable or inconsistent ownership evidence blocks deletion. Synthetic same-user `/proc` fixtures verify disguised binaries, owned working directories, legitimate idle processes, missing executable evidence and zombies without reading host private state. This is a safety check, **not** a substitute for a future authoritative in-process quiescence barrier for any Shell-enabled upgrade.

### Optional v2-only local identity purge (after uninstall)

The default `--uninstall` **never deletes private keys, device IDs or receipts**. If software has already been uninstalled and the owner deliberately wants to discard local v2 enrollment, a separate `--purge-local-identity` action in the same pinned Python bootstrap accepts only a non-root real terminal and requires typing `PURGE-V2-IDENTITY` after showing every exact identity file, the known device IDs and a warning that cloud revocation has **not** happened. The owner should first use authenticated MCP `revoke_device` for each matching ID. This does **not** prove any remote grant has been revoked or undo past operations.

The purge acquires the same per-user v2 installer flock before inspecting or changing local files, checks owner-only paths and disallows installed program versions, owned v2 units, active/unconfirmed v2 pairing processes, symlinks and unresolved re-pair/archive states. It removes **only** the existing `~/.local/share/mcp-workers/remote-control/v2-identity.pem{,.device-id}` and corresponding `temporary/` identities when safely present; it never recursively deletes the identity directory. The v1 identity, `~/.local/state/mcp-workers/remote-control-agent/operation-receipts.sqlite`, legacy receipt JSON/backups and their history are **always retained** because the receipt location is shared with the existing Agent and unknown side effects must not lose evidence. A future distinct receipt-purge feature would require separately reviewed v1 isolation and operator reconciliation; it is intentionally **not** part of this scope. `--purge-local-identity` has no valid published one-line command until the reviewed GitHub Release exists.
