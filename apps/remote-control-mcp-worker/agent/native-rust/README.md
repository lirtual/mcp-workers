# RCA Rust Native Agent — Gate 0 candidate

This crate is an unshipped, isolated migration candidate for [Spec #914](https://github.com/lirtual/mcp-workers/issues/914). The TypeScript/Node Agent remains authoritative and is not replaced by this crate. No supported Agent CLI, installer, Worker or Release workflow currently executes Rust.

Verified seams:

- Node 24's `operationDigest` custom JSON ordering, floating-point formatting and SHA-256, using fixed independent golden cases.
- Node 24's Ed25519 PKCS#8/SPKI session and Owner-intent signing transcripts; disposable public test seed generated in memory.
- Isolated loopback signed WebSocket challenge, explicit denial/invalid subprotocol rejection, bounded TCP connect and per-I/O TLS/WebSocket handshake waits, ping-frame handling, and one test-only read/write roundtrip through the guarded Rust `Gate0Probe` with persistent receipt and no-blind-replay on reconnect.
- Negative Gate 0 tests reject public/symlinked/wrong-name roots, out-of-scope paths, append-mode writes and malformed/oversized frames before mutation.
- Actual Worker source (`src/worker.ts`) in isolated local Wrangler with a SQLite Durable Object and throwaway temporary Owner Grant: signed Rust WebSocket, fresh file write, process restart, persisted same-ID status, idempotent same-ID replay, different-intent conflict and successful file read. The same path also passed over a short-lived Cloudflare Quick Tunnel with verified HTTPS/WSS.
- Durable SQLite `user_version=1` receipts, legacy JSON import, exclusive ownership, interrupted-operation Unknown and no-blind-replay, with a Node → Rust → Node interoperability test.

Test in a **disposable** checkout:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
```

Node 24 is required only for the interop test. The Rust library does not require Node at runtime.

### Disposable real-Worker verification adapter (unshipped)

The `gate0_nonprod` Cargo **example** is a bounded, Unix-only test client, not a supported Agent executable. It refuses the production hostname and accepts only an explicitly named `rca-rust-gate0-*.workers.dev` preview, the exact `http://127.0.0.1:8777/` with `--local`, or a one-label `*.trycloudflare.com` URL with `--quick-tunnel`. It reads only `gate0-test-key.pem` inside an owner-private absolute `rca-rust-probe-*` directory; this must be a separately created, **throwaway** PKCS#8 identity (0600), approved only in a disposable nonproduction Owner Grant. Never copy an existing paired Agent key or receipt folder. It handles 1–8 prearranged frames and exits; reconnect/status verification requires a fresh process and challenge while preserving only that same disposable SQLite directory.

```sh
# Dedicated disposable preview Worker, when independently provisioned:
cargo run --locked --example gate0_nonprod -- \
  https://rca-rust-gate0-TEST.account.workers.dev/ DEVICE_UUID \
  /tmp/rca-rust-probe-TEST 1

# Isolated local Wrangler on 127.0.0.1:8777, with a private test-only Owner Grant:
cargo run --locked --example gate0_nonprod -- \
  http://127.0.0.1:8777/ DEVICE_UUID /tmp/rca-rust-probe-TEST 1 --local

# Temporary TLS/WSS tunnel to that same isolated local Worker:
cargo run --locked --example gate0_nonprod -- \
  https://ONE-OFF.trycloudflare.com/ DEVICE_UUID \
  /tmp/rca-rust-probe-TEST 1 --quick-tunnel
```

2026-11-20 evidence: both the isolated local Worker and HTTPS/WSS Quick Tunnel tests passed with a disposable temporary grant. The latter used real signed WSS to the actual Worker implementation, but **not a Cloudflare-hosted deployment**. No production Worker, existing paired device, account secret or release was changed. The temporary tunnel, local Wrangler and test identities are removed after verification.

**Not yet accepted:** Cloudflare-hosted Worker runtime (the tunnel terminates at local Wrangler), end-to-end DNS/handshake deadline and heartbeat/periodic auth/reconnect lifecycle, production file/Shell handlers, cross-platform private paths/Windows ACLs, five-platform CLI/install/lifecycle, GitHub-hosted Sessions, release/rollback; #912 root and #911 Legacy. The local test-only effect is not a production executor. The current candidate refuses unchecked non-Unix private state. Never point it at a real paired device, current identity, or live receipt directory while another Agent can run.
