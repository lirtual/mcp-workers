# RCA Rust Native Agent

The shared Rust RCA core and OS adapters ship in the repository-wide immutable Stable Latest for Linux x64/arm64 and Windows x64. macOS x64/arm64 retain the Node v2 runtime; native macOS migration is deferred. [Spec #914](https://github.com/lirtual/mcp-workers/issues/914) records the real packaged Ubuntu and Windows Session acceptance, and the owner-approved deferral of physical permanent-device first enrollment/re-pair and successful detached stable-to-stable upgrade verification until actual use. Existing native lifecycle safeguards and recovery tests remain required. Root and Legacy remain independently tracked by #912 and #911.

## Runtime and release contract

- One Rust core, platform-owned process and filesystem adapters, signed rc-v2 WebSocket, connection-scoped leases, bounded response channel, and exclusive SQLite receipt owner. The single-thread Tokio reactor wakes on socket input, execution completion and liveness deadlines. Unknown effects are never blindly replayed.
- Linux uses the existing C process supervisor and Python stdlib for owner-local management. Windows uses the native process executor, owner-local Task controller and existing PowerShell installer. Neither released Rust archive includes a Node runtime or JavaScript Agent modules. The macOS Node runtime is still an active compatibility target.
- Owner-local initial enrollment, re-pair and upgrade retain existing identity and approval boundaries, signed recovery, PID-bound activation proof and durable recovery state. Detached stable upgrades reuse the same cutover and recovery, never treat launch or a running service as proof. Linux and Windows Node/mixed installations are retired; reinstall the native Rust Agent instead of migrating.
- Linux x64 and Windows x64 packages include the Rust Session entry. Linux arm64 does not declare a Session entry. Production Session workflows consume the immutable Latest release; existing sessions are not upgraded in place.
- Manual Native Agent candidates on main produces unpublished reviewed artifacts. Stable labels produce the five exact platform profiles; prerelease review artifacts are not promotable Stable assets. The separate owner-only agent-release workflow verifies exact source, immutable release settings, complete asset inventory, digests and Latest readback. Public installers resolve Latest dynamically. Compatible Agent updates do not require Worker redeployment.

## Verification

Use the existing CI and its published immutable v0.1.58 Rust baseline for native Linux recovery. The Linux systemd native-only integration verifies real activation, signed-proof refusal, interrupted recovery and identity/receipt preservation, including native-to-native rollback. The old mixed Node+Rust Linux package is not a supported release target and is no longer built by that recovery job. Historical migration experiments are recorded in Git and #914, not current maintenance requirements.

For routine Rust changes, use the crate's existing formatting, Clippy and test checks. Linux real process tests use the existing C supervisor built with `node agent/scripts/build-session-supervisor.mjs`; set `RCA_NATIVE_SUPERVISOR_BIN` to its absolute path. For macOS prototype process tests use `RCA_DARWIN_SUPERVISOR_BIN` with the existing Darwin helper; Windows uses the native Job Object executor. The following opt-in runbooks are disposable nonproduction test tools only, not supported installation commands or additional production release gates.

### Disposable CLI process-boundary tracer (nonproduction only)

`cargo run --locked --bin rca-native-nonprod -- --local DEVICE_UUID DISPOSABLE_ROOT` launches the existing signed native file session as a standalone Linux, macOS or Windows process. It only connects to the **exact** local Wrangler address `http://127.0.0.1:8777/` and requires a separately approved disposable identity at `gate0-test-key.pem` in an `rca-rust-probe-*` private directory. On Unix the root must be a direct canonical child of `/tmp` (0700; identity 0600, single link); SIGINT/SIGTERM stop the bounded reconnect loop. On Windows the root must be a direct child of the current user's temp directory with a protected owner/SYSTEM-only NTFS ACL; the CLI validates the root and single-link identity file through the existing Win32 handle/ACL guard and handles Ctrl+C/Ctrl+Break. A valid `gate0-test-key.pem.owner-stopped` marker blocks connection; invalid markers fail closed. Installed Node Agent state paths and production endpoints are always rejected. Unix root execution remains disabled; Windows root/elevation policy is a separate unverified gate.

An additional explicit **`--local-managed`** mode runs the existing platform-managed WSS executor in that same disposable CLI, without changing the default `--local` file-only policy. Linux requires `RCA_NATIVE_SUPERVISOR_BIN`, macOS requires `RCA_DARWIN_SUPERVISOR_BIN`, and Windows uses the already-validated native Job Object executor without a C helper. On Unix the selected variable must point to an absolute, canonical, owner-owned, executable C helper with no group/world write or setuid/setgid bits; missing or unsafe helpers fail before connecting or opening receipts. Both modes remain limited to the exact loopback Worker and private disposable root. Linux example with a separately built C helper and an approved **disposable** identity:

```sh
RCA_NATIVE_SUPERVISOR_BIN=/ABSOLUTE/DISPOSABLE/agent/.build/session-supervisor \
  cargo run --locked --bin rca-native-nonprod -- \
  --local-managed DEVICE_UUID /tmp/rca-rust-probe-UNIQUE
```

On macOS, pass the canonical temp path (not the `/tmp` symlink):

```sh
RCA_DARWIN_SUPERVISOR_BIN=/ABSOLUTE/DISPOSABLE/rca-darwin-supervisor \
  cargo run --locked --bin rca-native-nonprod -- \
  --local-managed DEVICE_UUID /private/tmp/rca-rust-probe-UNIQUE
```

On Windows, first create an existing disposable root directly inside the current user's temp directory and seal it with the same protected user/SYSTEM NTFS ACL as the test fixture; place only a disposable private PEM in it. A regular inherited temp ACL or junction fails closed. The command has no helper variable:

```powershell
cargo run --locked --bin rca-native-nonprod -- --local-managed DEVICE_UUID "$env:TEMP\rca-rust-probe-UNIQUE"
```

This is **not** an installed CLI, filesystem sandbox, pairing client or released Agent. A disposable local Worker can still authorize file operations with the current OS user's permissions; execute it only in an isolated, throwaway test host with known temporary file targets. The CLI process rejection/Stop tests are in `tests/nonprod_cli.rs`; the real-Owner WSS/file library contract remains in the opt-in `wrangler_native_file.rs`. The opt-in `wrangler_cli_process.rs` now verifies a **real Owner MCP → local Wrangler/SQLite DO → separate CLI subprocess** with a fresh temporary Grant: write/read, durable status, same-ID no-replay, changed-intent conflict and clean SIGTERM (Pass on an isolated Linux runner). The same test now restarts the process against its preserved private SQLite state, proves a new Owner write succeeds, then revokes the temporary Grant while its WSS is active: the process exits within 10 seconds and a subsequent Owner mutation produces no file effect. Its identity and Owner token come only from a separately approved private `/tmp/rca-gate1-file-*` fixture, never from an installed Agent; the fixture Grant and test files are removed after verification. The separate `tests/cli_managed.rs` executes the real CLI subprocess over signed loopback WSS with the actual C Supervisor: **SIGTERM** stops a live owned Shell, **Owner revoke** waits for confirmed cleanup and exits 0 after safe policy close (as in Node), and the original **file-only** CLI still rejects Shell with 1008 and its existing failure exit. Both managed shutdown paths persist the terminal SQLite receipt before process exit; uncertain cleanup still fails. These tests use independent temporary roots/identities and never contact a production Worker. This disposable CLI is not evidence of installed lifecycle acceptance; see #914 for current platform-specific results.

Test in a **disposable** checkout:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets

# Opt-in only: local Wrangler on 127.0.0.1:8777 and a fresh, privately
# approved temporary fixture (native-test-key.pem, device-id, owner-token).
RCA_LOCAL_NATIVE_FILE_ROOT=/tmp/rca-gate1-file-TEST cargo test --locked \
  --test wrangler_cli_process owner_file_receipt_and_sigterm_reach_real_cli_process \
  -- --ignored --exact --nocapture
```

For optional Unix physical CLI checks, build the platform C helper and reserve localhost port 8777. On Linux set `RCA_NATIVE_SUPERVISOR_BIN`; on macOS set `RCA_DARWIN_SUPERVISOR_BIN`, then run `cargo test --locked --test cli_managed -- --ignored --test-threads=1`. On Windows the real CLI/NTFS ACL/Job Object loopback test is `cargo test --locked --test windows_cli -- --nocapture`; it requires no C helper. These are disposable signed WSS and process/receipt checks, not installed Agent, real deployment or Node-to-Rust upgrade. No actual Worker or temporary Owner Grant is required.

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

This example exercises a restricted test path, not the production managed executor. Never point it at a real paired device, current identity, or live receipt directory while another Agent can run.
