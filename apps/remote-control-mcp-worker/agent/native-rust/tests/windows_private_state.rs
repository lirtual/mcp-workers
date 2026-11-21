//! Physical Windows ACL contract tests in disposable directories only.
//! A PowerShell/.NET fixture constructs the existing Node-style protected
//! user/SYSTEM DACL independently of the Rust Win32 validator.
#![cfg(windows)]

use rca_native_agent::receipts::{ReceiptError, ReceiptStore};
use std::path::Path;
use std::process::Command;

fn powershell(script: &str, values: &[(&str, &Path)]) {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    for (name, path) in values {
        command.env(name, path);
    }
    let result = command
        .output()
        .expect("disposable PowerShell test fixture");
    assert!(
        result.status.success(),
        "fixture: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

fn seal_dir(path: &Path) {
    powershell(
        r#"
$ErrorActionPreference = 'Stop'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($userSid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($sid in @($userSid, $systemSid)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($env:RCA_TEST_PATH, $acl)
"#,
        &[("RCA_TEST_PATH", path)],
    );
}

fn broad_grant(path: &Path, directory: bool) {
    let script = if directory {
        r#"
$ErrorActionPreference = 'Stop'
$acl = [IO.Directory]::GetAccessControl($env:RCA_TEST_PATH)
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $everyone, [Security.AccessControl.FileSystemRights]::ReadAndExecute,
  [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($env:RCA_TEST_PATH, $acl)
"#
    } else {
        r#"
$ErrorActionPreference = 'Stop'
$acl = [IO.File]::GetAccessControl($env:RCA_TEST_PATH)
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $everyone, [Security.AccessControl.FileSystemRights]::ReadAndExecute,
  [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.File]::SetAccessControl($env:RCA_TEST_PATH, $acl)
"#
    };
    powershell(script, &[("RCA_TEST_PATH", path)]);
}

#[test]
fn broad_windows_acl_refuses_receipts_before_creating_sqlite() {
    let root = tempfile::tempdir().unwrap();
    broad_grant(root.path(), true);
    let receipts = root.path().join("receipts");
    assert!(matches!(
        ReceiptStore::open(&receipts),
        Err(ReceiptError::UnsafePath)
    ));
    assert!(!receipts.join("operation-receipts.sqlite").exists());
}

#[test]
fn sealed_node_style_parent_accepts_inherited_receipts_and_reopens_sqlite() {
    let root = tempfile::tempdir().unwrap();
    seal_dir(root.path());
    let receipts = root.path().join("receipts");
    let store = ReceiptStore::open(&receipts).expect("owner-private SQLite admission");
    drop(store);
    let sqlite = receipts.join("operation-receipts.sqlite");
    assert!(sqlite.is_file());
    let reopen = ReceiptStore::open(&receipts).expect("same private v1 receipt store");
    drop(reopen);
    let conn = rusqlite::Connection::open(sqlite).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
}

#[test]
fn broad_directory_grant_fails_before_sqlite_side_effect() {
    let root = tempfile::tempdir().unwrap();
    seal_dir(root.path());
    let receipts = root.path().join("receipts");
    std::fs::create_dir(&receipts).unwrap();
    broad_grant(&receipts, true);
    assert!(matches!(
        ReceiptStore::open(&receipts),
        Err(ReceiptError::UnsafePath)
    ));
    assert!(!receipts.join("operation-receipts.sqlite").exists());
}

#[test]
fn broad_existing_sqlite_grant_is_rejected_before_parsing() {
    let root = tempfile::tempdir().unwrap();
    seal_dir(root.path());
    let receipts = root.path().join("receipts");
    std::fs::create_dir(&receipts).unwrap();
    let sqlite = receipts.join("operation-receipts.sqlite");
    std::fs::write(&sqlite, b"not-a-database").unwrap();
    broad_grant(&sqlite, false);
    assert!(matches!(
        ReceiptStore::open(&receipts),
        Err(ReceiptError::UnsafePath)
    ));
}

#[test]
fn junction_cannot_redirect_receipts_outside_private_root() {
    let root = tempfile::tempdir().unwrap();
    seal_dir(root.path());
    let destination = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    powershell(
        r#"
$ErrorActionPreference = 'Stop'
New-Item -ItemType Junction -Path $env:RCA_TEST_PATH -Target $env:RCA_TEST_TARGET | Out-Null
"#,
        &[
            ("RCA_TEST_PATH", &receipts),
            ("RCA_TEST_TARGET", destination.path()),
        ],
    );
    assert!(matches!(
        ReceiptStore::open(&receipts),
        Err(ReceiptError::UnsafePath)
    ));
    assert!(!destination
        .path()
        .join("operation-receipts.sqlite")
        .exists());
}
