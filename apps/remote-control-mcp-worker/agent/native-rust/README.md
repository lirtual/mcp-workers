# RCA Rust Native Agent — Gate 0 candidate

This crate is an unshipped, isolated migration candidate for [Spec #914](https://github.com/lirtual/mcp-workers/issues/914). The TypeScript/Node Agent remains authoritative and is not replaced by this crate. No CLI, installer, Worker or Release workflow currently executes Rust.

Verified seams:

- Node 24's `operationDigest` custom JSON ordering, floating-point formatting and SHA-256, using fixed independent golden cases.
- Node 24's Ed25519 PKCS#8/SPKI session and Owner-intent signing transcripts; disposable public test seed generated in memory.
- Isolated loopback signed WebSocket challenge, explicit denial/invalid subprotocol rejection, bounded TCP connect and per-I/O TLS/WebSocket handshake waits, ping-frame handling, and one test-only read/write roundtrip through the guarded Rust `Gate0Probe` with persistent receipt and no-blind-replay on reconnect.
- Negative Gate 0 tests reject public/symlinked/wrong-name roots, out-of-scope paths and malformed/oversized frames before mutation.
- Durable SQLite `user_version=1` receipts, legacy JSON import, exclusive ownership, interrupted-operation Unknown and no-blind-replay, with a Node → Rust → Node interoperability test.

Test in a **disposable** checkout:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
```

Node 24 is required only for the interop test. The Rust library does not require Node at runtime.

**Not yet accepted:** real TLS WSS / nonproduction Worker Owner Grant, end-to-end DNS/handshake deadline and heartbeat/periodic auth/reconnect lifecycle, production file/Shell handlers, cross-platform private paths/Windows ACLs, five-platform CLI/install/lifecycle, GitHub-hosted Sessions, release/rollback; #912 root and #911 Legacy. The local test-only effect is not a production executor. The current candidate refuses unchecked non-Unix private state. Never point it at a real paired device, current identity, or live receipt directory while another Agent can run.
