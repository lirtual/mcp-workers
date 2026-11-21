//! Public-process checks for the unshipped Unix RCA candidate.
#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;
use std::process::{Command, Stdio};
use tempfile::TempDir;

const TEST_DEVICE: &str = "123e4567-e89b-42d3-a456-426614174000";
#[cfg(target_os = "linux")]
const HELPER_ENV: &str = "RCA_NATIVE_SUPERVISOR_BIN";
#[cfg(target_os = "macos")]
const HELPER_ENV: &str = "RCA_DARWIN_SUPERVISOR_BIN";

fn run(root: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
        .args(["--local", TEST_DEVICE])
        .arg(root.canonicalize().unwrap())
        .output()
        .expect("nonproduction executable should launch")
}

fn private_root() -> TempDir {
    let root = tempfile::Builder::new()
        .prefix("rca-rust-probe-cli-")
        .tempdir_in("/tmp")
        .expect("private test root");
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    root
}

fn set_private(path: &Path) {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn cli_refuses_normal_agent_state_before_contacting_worker() {
    let output = run(Path::new("/tmp"));
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("untrusted disposable root"), "{stderr}");
}

#[test]
fn owner_stop_marker_blocks_launch_even_without_identity_material() {
    let root = private_root();
    let marker = root.path().join("gate0-test-key.pem.owner-stopped");
    fs::write(&marker, "").unwrap();
    set_private(&marker);
    let output = run(root.path());
    assert!(output.status.success(), "{:?}", output);
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("owner_stopped"),
        "{:?}",
        output
    );
    assert!(!root.path().join("receipts").exists());
}

#[test]
fn unsafe_owner_stop_marker_is_fail_closed() {
    let root = private_root();
    let target = root.path().join("target");
    fs::write(&target, "").unwrap();
    set_private(&target);
    symlink(
        &target,
        root.path().join("gate0-test-key.pem.owner-stopped"),
    )
    .unwrap();
    let output = run(root.path());
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unsafe owner STOP"));
    assert!(!root.path().join("receipts").exists());
}

#[test]
fn public_identity_is_rejected_before_network_or_receipt_creation() {
    let root = private_root();
    let identity = root.path().join("gate0-test-key.pem");
    fs::write(&identity, "NOT-A-REAL-PRIVATE-KEY").unwrap();
    fs::set_permissions(&identity, fs::Permissions::from_mode(0o644)).unwrap();
    let output = run(root.path());
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("test identity must be private"));
    assert!(!root.path().join("receipts").exists());
}

#[test]
fn sigterm_stops_retrying_nonproduction_process_without_reconnect_loop() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{Duration, Instant};

    let root = private_root();
    let identity = root.path().join("gate0-test-key.pem");
    fs::write(&identity, "DISPOSABLE-INVALID-KEY-NEVER-USED").unwrap();
    set_private(&identity);
    // Own the exact local test port so an unrelated Worker cannot reject this
    // disposable identity before SIGTERM and make the test timing-dependent.
    let listener = TcpListener::bind("127.0.0.1:8777").expect("isolated test port");
    listener.set_nonblocking(true).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
        .args(["--local", TEST_DEVICE])
        .arg(root.path().canonicalize().unwrap())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start nonproduction process");
    let ready_deadline = Instant::now() + Duration::from_secs(3);
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(value) => break value,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= ready_deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("candidate did not request a local signed challenge");
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("local test listener failed: {error}"),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut incoming = [0u8; 1024];
    let count = stream.read(&mut incoming).unwrap();
    assert!(incoming[..count].starts_with(b"POST /agent/session/challenge"));
    stream
        .write_all(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    if let Some(status) = child.try_wait().unwrap() {
        panic!("candidate exited before stop signal: {status}");
    }
    let sent = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
    assert_eq!(sent, 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "SIGTERM should stop cleanly: {status}");
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("SIGTERM did not end candidate within the bounded deadline");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn symlinked_disposable_root_is_refused_before_receipt_creation() {
    let target = private_root();
    // Reserve a direct /tmp child so only the symlink guard can reject it.
    // canonicalize() must not erase this untrusted caller-supplied path.
    let alias = tempfile::Builder::new()
        .prefix("rca-rust-probe-symlink-")
        .tempfile_in("/tmp")
        .unwrap();
    let link_path = alias.path().canonicalize().unwrap();
    fs::remove_file(&link_path).unwrap();
    symlink(target.path().canonicalize().unwrap(), &link_path).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
        .args(["--local", TEST_DEVICE])
        .arg(&link_path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("untrusted disposable root"));
    assert!(!target.path().join("receipts").exists());
}

#[test]
fn nested_disposable_named_directory_is_not_a_valid_test_root() {
    let parent = private_root();
    let nested = parent.path().join("rca-rust-probe-nested");
    fs::create_dir(&nested).unwrap();
    fs::set_permissions(&nested, fs::Permissions::from_mode(0o700)).unwrap();
    let output = run(&nested);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("untrusted disposable root"),
        "{:?}",
        output
    );
}

#[test]
fn managed_cli_fails_closed_without_an_explicit_trusted_supervisor() {
    let root = private_root();
    let identity = root.path().join("gate0-test-key.pem");
    fs::write(&identity, "DISPOSABLE-INVALID-KEY-NEVER-USED").unwrap();
    set_private(&identity);
    let no_helper = Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
        .args(["--local-managed", TEST_DEVICE])
        .arg(root.path().canonicalize().unwrap())
        .env_remove(HELPER_ENV)
        .output()
        .unwrap();
    assert!(!no_helper.status.success());
    assert!(
        String::from_utf8_lossy(&no_helper.stderr).contains("requires an explicit C supervisor")
    );
    assert!(!root.path().join("receipts").exists());

    let helper = root.path().join("helper");
    fs::write(&helper, "not a real C helper").unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
    let link = root.path().join("helper-link");
    symlink(&helper, &link).unwrap();
    let untrusted = Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
        .args(["--local-managed", TEST_DEVICE])
        .arg(root.path().canonicalize().unwrap())
        .env(HELPER_ENV, &link)
        .output()
        .unwrap();
    assert!(!untrusted.status.success());
    assert!(
        String::from_utf8_lossy(&untrusted.stderr).contains("untrusted nonproduction C supervisor")
    );
    assert!(!root.path().join("receipts").exists());
}
