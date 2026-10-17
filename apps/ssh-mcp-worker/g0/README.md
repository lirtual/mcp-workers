# G0 SSH client feasibility probe

This directory is a local-only disposable probe. It is not an MCP app, has no production Worker settings, bindings, secrets, or deployment command, and is not wired into CI. It covers T01's password/private-key handshake and one-shot exec boundary. PTY and SFTP remain for T02 (#85).

## Decision

Keep `@meitaim/ssh@1.0.0` as the sole client candidate for the next feasibility slice. It exposes a `workerd` conditional socket implementation and was exercised through Wrangler's local workerd runtime. Its KEX code (`dist/kex.js`, registry tarball below) validates the server's cryptographic host-key signature before it calls `verifyHostKey`; this probe compares that callback's SHA256 fingerprint to the fixture pin. A wrong pin is rejected before the fixture receives a user-authentication request.

The alternative evaluated was the SSH implementation at `lirtual/EdgeSSH@7a051e412d2cfa4ee52edec30e6ccefedb4e1c99` (`src/backend/session.ts`, `src/ssh/*`, Apache-2.0). It uses Workers APIs and verifies signatures before trusting the key, but `SSHSession` is coupled to EdgeSSH's browser WebSocket/session UI, interactive host confirmation, process monitoring, forwarding, and product-specific handlers. Adapting it into a headless client requires a larger extraction and carries unrelated behavior. No EdgeSSH files were copied or changed. The EdgeSSH source's `LICENSE` must be retained if that code is ever reused.

The package metadata declares MIT, author Meitaim OÜ. Exact artifact: npm registry `@meitaim/ssh@1.0.0`, `https://registry.npmjs.org/@meitaim/ssh/-/ssh-1.0.0.tgz`, SHA-512 `0BiWCrFXvdT9HKdbDDrcg1Vythtzh/hmjn1/E/9ln/LnZtIMixoTSu6LWwR6JZQc3O0HDR3vF1pcWAH0WLdUPQ==` (SHA-1 `59211de894220338deb248965e5f5079c7e04926`). The package metadata points to `github.com/Meitaim/meitaim-ssh`, but that repository was unavailable during this run; the npm artifact checksum is the reproducible source identity used here.

## Runtime and algorithms

- Wrangler `4.130.0`; its resolved workerd is `1.20260908.1` (from this repository's pnpm lockfile).
- Probe `compatibility_date`: `2026-09-10`; no Node compatibility flag.
- Fixture negotiated: KEX `curve25519-sha256`, server host key `ssh-ed25519`, both directional ciphers `aes256-gcm@openssh.com`.
- The pinned package advertises KEX `mlkem768x25519-sha256`, `curve25519-sha256`, `curve25519-sha256@libssh.org`, `sntrup761x25519-sha512`, `sntrup761x25519-sha512@openssh.com`, `ecdh-sha2-nistp256/384/521`, `diffie-hellman-group18-sha512`, `group16-sha512`, `group14-sha256`, and `group-exchange-sha256`; host keys Ed25519, ECDSA P-256/384/521, RSA SHA-2 256/512 and their OpenSSH certificate forms; ciphers AES-GCM, ChaCha20-Poly1305 and AES-CTR; MACs HMAC-SHA-2, HMAC-SHA-1 and UMAC variants. This is the package's advertised list, not a claim that every algorithm was exercised here.
- The fixture-only SSH server is `ssh2@1.17.0` (MIT), used from Node to supply a disposable protocol peer. It is not imported by the Worker bundle and is not the candidate SSH client.

## Reproduce

Requirements: Node `>=24 <25` (the repository engine), pnpm `10.17.1`, `ssh-keygen`, and free local ports `22222` and `8791`.

```sh
pnpm install --frozen-lockfile
pnpm --filter ssh-mcp-worker-g0 typecheck
pnpm --filter ssh-mcp-worker-g0 test:g0
```

The test creates temporary synthetic Ed25519 host and user keys, starts an isolated local SSH fixture with only fixed command behavior, and runs the Worker under `wrangler dev --local`. It verifies wrong-pin rejection before auth, password and private-key authentication, separate stdout/stderr and exit code, and a typed remote disconnect. Temporary keys and logs are removed at exit. No EdgeSSH data, real credentials, remote hosts, or cloud resources are read or used.

## Result and limits

T01's required SSH/KEX/signature/pin/auth/exec/disconnect path passed under workerd with no module-load WASM or Node API error. This does not pass all of G0: PTY/session lifecycle and SFTP are intentionally untested here and remain T02. The run uses a package registry artifact whose upstream Git repository could not be retrieved; retain this as a provenance/maintenance limitation for review.
