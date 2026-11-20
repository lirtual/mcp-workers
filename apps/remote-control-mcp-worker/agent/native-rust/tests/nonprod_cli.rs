//! Public-process checks for the unshipped Linux x64 RCA candidate.
#![cfg(target_os = "linux")]

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;
use std::process::{Command, Stdio};
use tempfile::TempDir;

const TEST_DEVICE: &str = "123e4567-e89b-42d3-a456-426614174000";

fn run(root: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
        .args(["--local", TEST_DEVICE])
        .arg(root)
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
fn sigterm_stops_disconnected_nonproduction_process_without_retry_loop() {
    use std::thread;
    use std::time::{Duration, Instant};

    let root = private_root();
    let identity = root.path().join("gate0-test-key.pem");
    fs::write(&identity, "DISPOSABLE-INVALID-KEY-NEVER-USED").unwrap();
    set_private(&identity);
    let mut child = Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
        .args(["--local", TEST_DEVICE])
        .arg(root.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start nonproduction process");
    thread::sleep(Duration::from_millis(250));
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
