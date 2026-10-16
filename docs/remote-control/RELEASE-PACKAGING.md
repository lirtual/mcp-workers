# Remote Control standalone Release packaging (#73) — local-only gate

**Status:** Draft implementation; no independently verified published Agent asset, no clean-host ARM64 test, no one-command installation yet. **Do not advertise a download command.**

## Reviewed offline build

Run from a trusted clean checkout of the intended commit, on **each target's native Linux glibc CPU** with Node.js 24, TypeScript dev dependency, cc and tar/gzip installed **on the build host only**. Native Supervisor must already have been compiled and probed using `node scripts/build-session-supervisor.mjs`. The portable install host does **not** compile it.

```sh
node apps/remote-control-agent/scripts/build-v2-release.mjs \
  --version v0.1.0 \
  --target linux-x64-glibc \
  --node-bin /absolute/verified/node24/bin/node \
  --node-sha256 <independently-checked-64-hex-Node-SHA256> \
  --native /absolute/verified/session-supervisor \
  --native-sha256 <checked-64-hex-Supervisor-SHA256> \
  --out /fresh/output-directory
```

The builder checks ELF machine IDs, executable permissions, matching native build CPU/libc, actual Node24, native signal-0 pidfd capability, pinned input hashes, TS runtime dependency graph, and excludes test fixtures, .git, source checkout, tokens and user private state. Deterministic ustar with fixed owner, group, mode and timestamp plus gzip `-n` yields a version-and-target-qualified `tar.gz`. Local build SHA-256 is a **comparison value only**, not an independently authoritative published digest.

Supported release **candidates**: `linux-x64-glibc`, `linux-arm64-glibc`; host-specific binary build and smoke tests are required for *each*. WSL2 is Linux, not a Windows binary. musl, older kernel and unsupported libc are refused, no fallback.

## Read-only verification contract

The portable verifier `scripts/verify-v2-release.mjs` exposes `fetchAndStagePinnedRelease({ tag, commit, target, destination })`. A future **reviewed** bootstrap will invoke this logic, never a generated `latest` URL. The verifier checks the public published Release's observed immutability, including exact `immutable=true`, exact tag-to-commit ref (including annotated tag peel), named target asset ID, uploaded asset size and official SHA-256 `digest`. It then downloads that immutable asset through bounded official GitHub HTTPS origins with manual redirects, checks the complete bytes against the official digest and expected size, validates all restricted ustar members before writing, and stages under a fresh owner-only directory before atomic no-overwrite promotion. No uploaded archive contents execute during verification.

GitHub's repository-level immutable-release settings endpoint returned HTTP 401 without credentials; clean-host installers must never request maintainer credentials. Repository settings must be checked separately before publication.

GitHub's official API reports `immutable` and per-asset `digest`, but such metadata is **not** an independent attestation of the publisher or bootstrap shell-script provenance. Before claiming a real public release has been verified, a separate human reviewer must confirm published immutable setting, trusted binary provenance, tag/commit and optional GitHub release attestations.

**Verification currently completed:** local WSL2 Linux 6.18.33.2, x86_64, glibc 2.39, Node24.21.0. Built an unuploaded offline sample; SHA-256, strict unpack and JS entrypoint syntax tested. Offline negative tests validate missing/altered digest, immutable flag, wrong pinned commit, hostile redirects, traversal, symlinks, duplicate paths, unsupported ELF architecture, corrupt archive and preserving an existing destination. No clean-host no-toolchain end-to-end installer or actual ARM64 verification has occurred.

## Remaining release blockers

- Independently verify the source and checksum of bundled Node24, and record a reviewed Release tag, commit and official asset IDs/digests **after an explicitly authorized** draft-asset upload and immutable publication. Publishing anything requires separate approval.
- Cross-compile is **not** silently accepted. Use a genuine ARM64 glibc build host and independent clean-host acceptance, including minimum glibc ABI compatibility and real kernel pidfd support.
- The packed development `install-v2.mjs` still refers to checkout/source paths and a local compiler. **T05 (#74)** must adapt its runtime/service template to the verified installed layout and supply the reviewed initial bootstrap; do not execute the included development installer as a supported clean-host install command.
- T06–T09 and single-device 48-hour real observation (#57), full code review, CI checks and manual production authority remain separate gates.
