# ADR-0019 — Remote Control v2 standalone Linux/WSL2 CLI distribution

**Status:** Product and distribution decisions **accepted** (Grilling with Docs 2026-10-17, Q1=A / Q2=A / Q3=A); **release trust, upgrade, uninstall, recovery and detailed UX undecided**. Documentation only; not implemented or deployed.

Related: [v2 multi-device Spec](../V2-MULTI-DEVICE-SPEC.md), [ADR-0015 — independent on-device pairing](./0015-v2-pairing-and-identity.md), [ADR-0017 — remove device authorization](./0017-v2-device-revocation-without-tombstones.md), [ADR-0018 — 24-hour temporary device grants](./0018-v2-temporary-agent-pairing-lifecycle.md).

## Context / observed current implementation

The existing Agent is a native Linux/WSL2 program. The unmerged v2 [Draft PR #58](https://github.com/lirtual/mcp-workers/pull/58) has a source-checkout installer `apps/remote-control-agent/scripts/install-v2.mjs`, which requires Node.js 24, `cc` and a C pidfd/session-supervisor helper built locally. Persistent service mode additionally requires a systemd user manager and points its unit at files in the source checkout. `--foreground` avoids creating a service, but still requires the checkout/toolchain. The project currently has **no Agent binary artifacts published in GitHub Releases**. Merely providing a one-line wrapper around `git clone` and native compilation does not achieve the user goal.

## Accepted choices — first grilling round

1. **Q1=A: Linux-first device scope.** The first supported standalone installer targets **Linux x86_64 and ARM64**, including those architectures running inside **WSL2**. Native Windows and macOS agents are not within this rollout; WSL2 is a Linux execution environment, not a native Windows Agent. The distribution/CPU ABI, supported Linux libc and minimum OS version still require verification. Do not infer all Linux distributions or all ARM64 devices are compatible.
2. **Q2=A: GitHub Releases bundled portable runtime.** Publish versioned **prebuilt Agent distributions as GitHub Release assets**, containing the required **Node.js runtime**, Agent JavaScript and **precompiled native Shell Supervisor** for a supported OS/architecture. Installing must **not** require `git clone`, `pnpm`, TypeScript builds, locally installed Node.js, or local `cc`. The package uses the **existing Node Agent and execution engine**; do not introduce a Rust/Go rewrite or require a single self-extracting executable. Package topology, checksums/signatures, artifact provenance, how assets are produced and supported libc matrix are not yet decisions.
3. **Q3=A: interactive single-command onboarding.** A supported new host begins with **one terminal command** to obtain and launch the installer. The **local CLI guides the user to choose either a normal permanent enrollment or a temporary enrollment**, rather than selecting a hidden default. The CLI must complete or safely resume the existing owner-reviewed two-code pairing. Whether the permanent Agent is started as a user service and temporary as foreground, and how to handle hosts without a user-systemd manager, remain explicit next-round decisions.
4. **Keep authorization independent from installation.** Only a device-held Ed25519 private key and the existing local interactive human-confirmed pairing may activate a new device. Show the **10-character, 10-minute pending code**, then require independent Portal/MCP `pairing_lookup` and `pairing_prepare`; the owner enters the **12-character, single-use local confirmation challenge** (up to five minutes) in the target terminal. Neither a downloaded file nor the one-line command is itself authorization. Never ship a private key, owner Portal Bearer, Cloudflare admin token, or reusable secret in an asset or command.
5. **Preserve approved device lifetimes.** Temporary approval is fixed and nonrenewable **24 hours after the server confirms enrollment**, with server-side denial of new operations at expiry; permanent approval does not inherit that expiry. Revoked device records are deleted per ADR-0017. Local installer experience must not automatically recover previously revoked/expired server authorizations or silently replace another approved identity.
6. **No v1 or production interference.** Distribution installs and service changes must be scoped to v2 and the operator's chosen Linux user, never overwrite v1 production or another existing v2 identity without explicit review. No new Worker, DO, D1/KV/R2, login service, new CI workflow or release/production action is authorized by these documentation decisions.

## Expected visible UX (illustrative, not a publishable command)

An owner invokes a single installation command **whose domain and exact syntax are not yet selected**; local CLI then prompts `Permanent device` or `Temporary device (24 hours)`, displays a pending code and optional fingerprint, accepts the one-time terminal challenge, verifies approved identity, and reports the device ID, mode, connectivity and next management steps. A real installation URL or release asset **must not** be claimed available before it exists and is verified.

## Design consequences

- **Benefits:** no repository checkout, local compiler or package-manager setup; one supported Linux Agent codebase; symmetric x86_64/ARM64/WSL2 onboarding; no new authentication authority; same familiar CLI for permanent and temporary use.
- **Costs:** cross-architecture release artifacts (including Node and native helper), trustworthy distribution and upgrade/rollback paths, Linux ABI compatibility, per-user service integration and safe local credential handling all become requirements. Adding a one-line shell wrapper without those requirements is inadequate.
- **Scope restriction:** permanent/temporary selection and actual byte distribution are now accepted. Repository PR #58 still lacks Release assets and the standalone installation path; this ADR does not authorize implementation, changing release secrets, or deploying.

## Next Grilling frontier — decisions not yet approved

**Q4 — release integrity and one-line installer:** whether the first-release trust boundary uses a pinned/reviewed HTTPS release script with immutable-version assets and verified SHA-256 manifest, or additionally mandates signed provenance/cryptographic release attestations. Neither use of `curl | sh` nor a particular hostname is yet approved. A downloaded script is active code: integrity checks performed *by that script* do not independently authenticate the script itself.

**Q5 — upgrade and rollback:** manual explicit-version upgrade with current identity preservation and atomic rollback vs unattended auto-update; policy for remote protocol and agent compatibility remains open.

**Q6 — uninstall scope:** local code/service removal only with an independent owner `revoke_device` action vs terminal offering an authenticated device-scoped removal; avoid embedding owner secrets or claiming deletion when remote unavailable.

**Q7 — partial installation/re-pair recovery:** rerun the same one-liner to resume safely and verify owner-only local key/ID state, or expose distinct recovery subcommands; decide collision treatment for existing installed v1/v2.

**Q8 — CLI interaction/host service:** exact prompts, noninteractive/non-TTY error semantics, permanent-background/temporary-foreground lifecycle, systemd-unavailable Linux/WSL behavior. Ask only after Q4–Q7 decisions where dependent.

Acceptance must include clean Linux x86_64/ARM64 + WSL2 hosts without git/pnpm/node/cc, a locked-down installer archive, architecture/libc mismatch rejection, wrong signature/checksum failure, pairing misuse, partial install/crash/retry, offline re-pair rejection, local permissions and v1 isolation. Prefer reusing existing CI; no new workflow unless explicitly authorized or demonstrably required.
