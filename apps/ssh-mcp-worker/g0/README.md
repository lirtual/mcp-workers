# G0 SSH client feasibility probe

This directory is a local-only disposable probe. It is not an MCP app, has no production Worker settings, real host bindings, secrets, or deployment command, and is not wired into CI. It evaluates the single `@meitaim/ssh@1.0.0` client selected by T01 with the existing Node `ssh2@1.17.0` fixture. The fixture is only the SSH server; it is not imported by the Worker bundle and is not a second client engine.

## Decision and provenance

Keep `@meitaim/ssh@1.0.0` as the sole client candidate. Wrangler's local runtime executes its conditional `workerd` socket implementation. The client validates the server host-key signature during KEX before calling the pin callback; this probe compares that callback's SHA256 fingerprint with a synthetic pin and proves a wrong pin is rejected before any SSH user-authentication request reaches the fixture.

The alternative evaluated was the SSH implementation at `lirtual/EdgeSSH@7a051e412d2cfa4ee52edec30e6ccefedb4e1c99` (`src/backend/session.ts`, `src/ssh/*`, Apache-2.0). It uses Workers APIs and verifies signatures before trusting the key, but `SSHSession` is coupled to EdgeSSH's browser WebSocket/session UI, interactive host confirmation, process monitoring, forwarding and product-specific handlers. Extracting it into a headless client is a larger change with unrelated behavior. No EdgeSSH files were copied or changed. If its code is reused later, its Apache-2.0 license and notices must be retained.

The selected package metadata declares MIT, author Meitaim OÜ. Its npm artifact is `https://registry.npmjs.org/@meitaim/ssh/-/ssh-1.0.0.tgz`, SHA-512 `0BiWCrFXvdT9HKdbDDrcg1Vythtzh/hmjn1/E/9ln/LnZtIMixoTSu6LWwR6JZQc3O0HDR3vF1pcWAH0WLdUPQ==` (SHA-1 `59211de894220338deb248965e5f5079c7e04926`). Package metadata points to `github.com/Meitaim/meitaim-ssh`, but that repository was unavailable during this run; the registry artifact checksum is the reproducible source identity. Provenance and maintenance ownership remain review limitations.

## Runtime, protocols and evidence

- Wrangler `4.130.0`; resolved workerd `1.20260908.1` from the repository lockfile; compatibility date `2026-09-10`; no Node compatibility flag.
- SSH fixture `ssh2@1.17.0` (MIT) runs in Node, bound only to local fixture traffic. Its password check compares against the synthetic `synthetic-password`. Public-key auth accepts a matching unsigned key query only as the SSH PK_OK prelude, then grants login only after `authorizedPublicKey.verify(blob, signature, hashAlgo)` succeeds. A generated unauthorized key is rejected.
- The fixture negotiates KEX `curve25519-sha256`, host key `ssh-ed25519`, and `aes256-gcm@openssh.com` in both directions. The selected package advertises KEX `mlkem768x25519-sha256`, `curve25519-sha256`, `curve25519-sha256@libssh.org`, `sntrup761x25519-sha512`, `sntrup761x25519-sha512@openssh.com`, `ecdh-sha2-nistp256/384/521`, `diffie-hellman-group18-sha512`, `group16-sha512`, `group14-sha256`, and `group-exchange-sha256`; host keys Ed25519, ECDSA P-256/384/521, RSA SHA-2 256/512 and OpenSSH certificate forms; AES-GCM, ChaCha20-Poly1305 and AES-CTR ciphers; HMAC-SHA-2, HMAC-SHA-1 and UMAC MACs. These are advertised algorithms, not all individually tested.
- PTY flow: the client requests `xterm-256color` (80×24), then requests a shell; the fixture rejects shell without a PTY, accepts input in a subsequent HTTP request, returns `fixture says hello`, and records shell channel close. A second session is closed by the server while input is active, and the DO observes the channel as closed. A local SQLite-backed DO instance holds the live client/channel in memory between these requests. The test waits 1.2 seconds after the start response before sending shell input, so this proves actual workerd TCP/SSH use across multiple completed HTTP requests, not just an in-request stream.
- SFTP flow: the same client opens an SFTP subsystem and performs directory list, UTF-8 read (`héllo SSH`), short UTF-8 write (`short UTF-8 ✓`) and a read over a later SSH connection to confirm the write's effect. The disposable fixture provides only fixed `/fixture` paths in an in-memory file map. Missing-file status and a server-initiated SSH disconnect during directory open both fail visibly. Server logs and assertions verify that file/directory handles close, all six SFTP sessions terminate with zero remaining handles, and the six corresponding SSH TCP connections close.
- Existing T01 checks remain: bad host pin before auth, wrong password, wrong public key, valid signed private key, valid password, one-shot stdout/stderr/exit code, and remote disconnect.

## Reproduce

Requirements: Node `>=24 <25` (repository engine), pnpm `10.17.1`, and `ssh-keygen`. The runner allocates temporary local ports for its disposable SSH and workerd fixtures.

```sh
pnpm install --frozen-lockfile
pnpm --filter ssh-mcp-worker typecheck
pnpm --filter ssh-mcp-worker test:g0
```

The test generates temporary synthetic Ed25519 host, authorized-user, and unauthorized-user keys, starts the local SSH fixture, and runs the Worker using `wrangler dev --local`. Temporary keys, logs and fixture processes are cleaned up on exit. It does not use EdgeSSH data, real credentials, remote hosts, or cloud resources.

## Durable Object and TCP lifetime limits

The local DO proof is deliberately narrow: one local workerd DO owns one in-memory SSH client and PTY channel across requests. It does not prove survival across DO eviction, runtime updates, process restart, deployments, or a long-duration session. It uses no durable receipt/session storage and has no production application binding.

Cloudflare's [DO lifecycle documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) currently says an active outbound TCP socket prevents its DO from eviction for up to 15 minutes per connection. After that protection window, ordinary eviction rules apply even though the socket may continue operating; after the last active connection closes, an idle non-hibernatable DO can be evicted after roughly 70–140 seconds without requests/events. This is a runtime eviction protection, not a promised SSH lifetime or guaranteed socket uptime. Cloudflare's [TCP Sockets documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) also notes the DO duration cost while that protection applies. No actual Cloudflare account plan, quota, deployed namespace, or production route was inspected, and this probe does not claim a free-plan or account-specific runtime measurement.

Technical result: this candidate demonstrated the specified G0 protocol path locally under workerd. Limitations for review: package source ownership/repository provenance is uncertain; the negotiated algorithm set is a single fixture run; the SFTP fixture has a tiny in-memory filesystem rather than a POSIX server; cross-request PTY liveness was checked for 1.2 seconds only; DO eviction/disconnect recovery and real Cloudflare behavior were not tested. There is no guarantee of permanent Shell uptime, nor does a DO session ID establish that a transport survived eviction.
