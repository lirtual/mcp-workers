# RCA Rust Native Agent — Gate 0 verified / Gate 1 candidate

This crate is an unshipped migration candidate for [Spec #914](https://github.com/lirtual/mcp-workers/issues/914). Gate 0 passed and merged in PR #915; Gate 1 signed WSS transport was merged in [PR #916](https://github.com/lirtual/mcp-workers/pull/916). The following native read_file executor is another Gate 1 candidate slice, not overall Gate 1 completion. The TypeScript/Node Agent remains authoritative. No supported Agent CLI, installer, Worker or Release workflow executes Rust.

Verified seams:

- Node 24's `operationDigest` custom JSON ordering, floating-point formatting and SHA-256, using fixed independent golden cases.
- Node 24's Ed25519 PKCS#8/SPKI session and Owner-intent signing transcripts; disposable public test seed generated in memory.
- Isolated loopback signed WebSocket challenge, explicit denial/invalid subprotocol rejection, bounded TCP connect and per-I/O TLS/WebSocket handshake waits, ping-frame handling, and one test-only read/write roundtrip through the guarded Rust `Gate0Probe` with persistent receipt and no-blind-replay on reconnect.
- Negative Gate 0 tests reject public/symlinked/wrong-name roots, out-of-scope paths, append-mode writes and malformed/oversized frames before mutation.
- Actual Worker source (`src/worker.ts`) with SQLite Durable Object and throwaway temporary Owner Grant: signed Rust WebSocket, fresh file write, process restart, persisted same-ID status, idempotent same-ID replay, different-intent conflict and successful file read. Verified over local Wrangler, a short-lived HTTPS/WSS Cloudflare Quick Tunnel, and a disposable **Cloudflare-hosted** Worker account.
- Durable SQLite `user_version=1` receipts, legacy JSON import, exclusive ownership, interrupted-operation Unknown and no-blind-replay, with a Node → Rust → Node interoperability test.
- Gate 1 **nonproduction Rust native `read_file`**: strict authenticated `read` envelope and UUID validation before queueing, Node-compatible local path/offset/length validation, ordinary/tail line reads with a 1 MiB scan cap, nonblocking regular-file check, lossy UTF-8 handling, 200K UTF-16-char and 65,536-byte encoded WSS reply caps without truncated secrets, and failed `read_result` on invalid path/arguments. The separate reader thread keeps signed WSS heartbeat and Grant probes alive. Unsupported read tools, writes and Shell are not admitted by this limited native read transport (policy 1008); no device capability is advertised. Signed loopback WSS tests verify a real file read and denied mutation. A disposable **real Worker + SQLite DO + temporary Owner Grant** has now independently delivered an MCP `read_file` call to Rust and received exact file contents; unauthorized Owner 401 and revoked identity fresh-challenge denial were also observed. The opt-in `wrangler_native_read.rs` test records this flow without touching production.
- Gate 1 signed WSS `rc-v2:ping/pong`, per-nonce periodic Grant validation, bounded transport queue, connection-specific revocable execution leases and response incarnation isolation. Bounded 1/2/4/8/16/30s reconnect reclaims a fresh signed challenge on transient faults (including 408/425/429/5xx); HTTP 401/403/404, 1008 and incompatible protocol stop permanently, `superseded` ends cleanly. A shared Stop signal fences already queued requests immediately and prevents new post-Stop admissions. A real local Wrangler + SQLite DO temporary Grant passed the 30-second rate gate, valid auth ACK, Owner `revoke_cleanup`, 1008 closure and fresh challenge denial. No real process execution or cleanup is provided by this transport crate.

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

2026-11-20 evidence: isolated Wrangler, HTTPS/WSS Quick Tunnel, and disposable Cloudflare-hosted Worker tests passed with temporary grants. No production Worker, existing paired device, account secret or release was changed. All disposable local/tunnel/hosted test credentials and Worker resources are removed or allowed to expire after verification.

**Gate 1 remains Partial:** the native file-read library is wired into a non-installable WSS runner, but device-info/capability announcement, additional file/search tools, Shell and managed process execution, cross-platform private paths/Windows ACLs, five-platform CLI/install/lifecycle, GitHub-hosted Sessions, release/rollback remain unverified or unimplemented; #912 root and #911 Legacy remain independently gated. The cleanup callback may return `confirmed` only after the future real executor verifies all owned processes stopped; otherwise the current transport reports `uncertain`. Worker rate-limits Grant probes for the first 30 seconds and again within 30 seconds after a prior probe; the default Rust cadence is 15 minutes. The local test-only effect is not a production executor. The current candidate refuses unchecked non-Unix private state. Never point it at a real paired device, current identity, or live receipt directory while another Agent can run.
