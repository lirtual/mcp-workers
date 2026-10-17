# Standalone Agent one-command bootstrap — Draft, not yet published

**Not a runnable public install command yet.** Draft PR #79 includes an offline-tested
version-pinned Python3 stdlib bootstrap at
`apps/remote-control-agent/scripts/bootstrap-v2.py`.
There is **no authorized immutable Agent GitHub Release** or verified ARM64 package.
Do not install the production Agent or use a guessed GitHub Release URL.

The final reviewed one-line invocation will take this form **only after** the
real Release tag, immutable source commit and published official SHA-256 digest
have been verified by a maintainer:

```sh
bash -c 'set -eu; code=$(curl -fsSL --proto =https --tlsv1.2 "https://raw.githubusercontent.com/lirtual/mcp-workers/<REVIEWED_40_CHAR_COMMIT>/apps/remote-control-agent/scripts/bootstrap-v2.py"); exec python3 -c "$code" --tag <PUBLISHED_TAG> --commit <REVIEWED_40_CHAR_COMMIT> --endpoint https://<REVIEWED_WORKER_ORIGIN>/'
```

**Do not copy/paste the placeholders.** All references are pinned; there is no
`latest` or `main`. Shell uses command substitution, **not** `curl|bash`,
so Python/CLI inherits the real controlling TTY for the mandatory mode/challenge
prompts. HTTP/TLS failures must abort the command (`set -e`). Python3 3.8+
and curl are **bootstrap prerequisites**; unlike the Agent, no system Node,
npm/pnpm, git or compiler is required. This Python prerequisite must be
reviewed against the supported clean-host matrix before the one-liner is
declared available. An immutable commit-pinned source URL is still not
independent cryptographic proof of the publisher.

The bootstrap itself fail-closes unless:
- Linux x86_64 or ARM64, non-root, kernel >=6.9, glibc >=2.28 as a base gate, an archive-specific measured `glibc_min` requirement, and TTY. The local x64 Supervisor currently needs glibc >=2.34; ARM64 minimum remains unverified.
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

**Offline evidence only:** public API and malicious archive cases simulated in
`tests/v2-bootstrap.test.mjs`; a genuinely built local x64 archive was
verified, safely unpacked and checked to refuse overwrite. No real
published Release or paired service has been activated from this path.

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

**Required human decisions/steps later:** review Release immutability settings
with maintainer credentials, trusted Node binary provenance, verify ARM64 and
x64 clean-host ABI/runs, explicitly approve publishing any Release, then
authorize the target's live pairing and #57 real 48-hour acceptance. None of
these is implied by CI success.

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

Optional local identity/receipt purge is not enabled until its own explicitly
confirmed and scope-reviewed tests; do not improvise rm -rf on private state.
Commands remain Draft: do not advertise a public bootstrap/release until
the actual official immutable Release and clean-host acceptance are complete.

### Local activation and rollback failure-injection evidence

An isolated user-home test (`apps/remote-control-agent/tests/v2-upgrade-rollback.test.mjs`) replaces only `systemctl` and `systemd-analyze` with test-local executables on `PATH`. It covers (1) failed manual v2 activation restores the exact previous owned service definition, (2) successful v2 upgrade commits the new service definition, and (3) failed first install removes only the newly staged v2 unit. In every case, sample private key, device ID, and SQLite receipt bytes remain unchanged. This is **offline fault injection**, not live production systemd/Cloudflare WSS acceptance.

Separately, a non-root network-disabled Debian Bookworm clean-host smoke test (glibc 2.36, no system Node, Git or C compiler, read-only container root) verified an **unpublished x64 local bundle** using the Python bootstrap, safely unpacked it, started bundled Node 24.21.0, passed the native PIDFD Supervisor probe and checked the JS entry syntax. This validates one additional ABI environment beyond the build host (glibc 2.39); **it does not claim a live GitHub Release or signed owner pairing**, and does not substitute for native ARM64 acceptance.

### Active Agent uninstall refusal

The local program removal guard now verifies `/proc/<pid>/exe` and the process working directory alongside the argument vector, because a running Agent may rewrite/hide its command line. Exited zombies do not count as running; unreadable or inconsistent ownership evidence blocks deletion. Synthetic same-user `/proc` fixtures verify disguised binaries, owned working directories, legitimate idle processes, missing executable evidence and zombies without reading host private state. This is a safety check, **not** a substitute for a future authoritative in-process quiescence barrier for any Shell-enabled upgrade.
