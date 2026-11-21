//! Real Windows subprocess acceptance checks for the unshipped #914 CLI.
//! All test identities and ACL fixtures live under disposable temp roots.
#![cfg(windows)]
mod common;

use std::fs;
use std::path::Path;
use std::process::Command;

const DEVICE: &str = "123e4567-e89b-42d3-a456-426614174000";
const MARKER: &str = "gate0-test-key.pem.owner-stopped";

fn root() -> tempfile::TempDir {
    let temp = tempfile::Builder::new()
        .prefix("rca-rust-probe-win-cli-")
        .tempdir()
        .unwrap();
    common::seal_windows_dir(temp.path());
    temp
}

fn launch(mode: &str, device: &str, root: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
        .args([mode, device])
        .arg(root)
        .output()
        .unwrap()
}

fn stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).to_string()
}

#[test]
fn cli_rejects_regular_agent_path_and_invalid_uuid_before_wss() {
    let normal = std::env::temp_dir().canonicalize().unwrap();
    let invalid_root = launch("--local", DEVICE, &normal);
    assert!(!invalid_root.status.success());
    assert!(
        stderr(&invalid_root).contains("untrusted disposable root"),
        "{:?}",
        invalid_root
    );
    let disposable = root();
    let invalid_device = launch("--local", "not-a-uuid", disposable.path());
    assert!(!invalid_device.status.success());
    assert!(
        stderr(&invalid_device).contains("only explicit local modes"),
        "{:?}",
        invalid_device
    );
    assert!(!disposable.path().join("receipts").exists());
}

#[test]
fn owner_stop_prevents_network_and_receipts_without_identity() {
    let disposable = root();
    fs::write(disposable.path().join(MARKER), "").unwrap();
    let stopped = launch("--local-managed", DEVICE, disposable.path());
    assert!(stopped.status.success(), "{:?}", stopped);
    assert!(stderr(&stopped).contains("owner_stopped"), "{:?}", stopped);
    assert!(!disposable.path().join("receipts").exists());
}

fn grant_everyone_read(path: &Path) {
    let result = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"
$ErrorActionPreference = 'Stop'
$acl = [IO.File]::GetAccessControl($env:RCA_TEST_PATH)
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $everyone, [Security.AccessControl.FileSystemRights]::ReadAndExecute,
  [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.File]::SetAccessControl($env:RCA_TEST_PATH, $acl)
"#,
        ])
        .env("RCA_TEST_PATH", path)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn unsafe_stop_marker_refuses_launch() {
    let disposable = root();
    let marker = disposable.path().join(MARKER);
    fs::write(&marker, "").unwrap();
    grant_everyone_read(&marker);
    let output = launch("--local", DEVICE, disposable.path());
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("unsafe owner STOP"),
        "{:?}",
        output
    );
    assert!(!disposable.path().join("receipts").exists());
}

#[test]
fn broad_identity_acl_rejected_before_network_or_receipts() {
    let disposable = root();
    let key = disposable.path().join("gate0-test-key.pem");
    fs::write(&key, common::test_pem()).unwrap();
    grant_everyone_read(&key);
    let output = launch("--local", DEVICE, disposable.path());
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("test identity must be private"),
        "{:?}",
        output
    );
    assert!(!disposable.path().join("receipts").exists());
}

#[test]
fn nested_disposable_root_is_rejected() {
    let disposable = root();
    let nested = disposable.path().join("rca-rust-probe-nested");
    fs::create_dir(&nested).unwrap();
    let output = launch("--local", DEVICE, &nested);
    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("untrusted disposable root"),
        "{:?}",
        output
    );
    assert!(!disposable.path().join("receipts").exists());
}
