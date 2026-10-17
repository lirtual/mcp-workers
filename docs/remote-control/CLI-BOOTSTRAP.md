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
- Linux x86_64 or ARM64, non-root, kernel >=6.9, glibc >=2.28 and TTY.
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

**Required human decisions/steps later:** review Release immutability settings
with maintainer credentials, trusted Node binary provenance, verify ARM64 and
x64 clean-host ABI/runs, explicitly approve publishing any Release, then
authorize the target's live pairing and #57 real 48-hour acceptance. None of
these is implied by CI success.
