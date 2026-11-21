//! Physical Windows ACL contract tests in disposable directories only.
//! A PowerShell/.NET fixture constructs the existing Node-style protected
//! user/SYSTEM DACL independently of the Rust Win32 validator.
#![cfg(windows)]

mod common;

use rca_native_agent::native_file::{run_native_file_session, NativeFileError};
use rca_native_agent::native_write::NativeWriteError;
use rca_native_agent::receipts::{ReceiptError, ReceiptStore};
use rca_native_agent::session::HeartbeatTiming;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::protocol::{Message, WebSocket};

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
    common::seal_windows_dir(path);
}

fn seal_file(path: &Path) {
    powershell(
        r#"
$ErrorActionPreference = 'Stop'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($userSid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($userSid, $systemSid)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
[IO.File]::SetAccessControl($env:RCA_TEST_PATH, $acl)
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
    seal_dir(&receipts);
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
    seal_dir(&receipts);
    let sqlite = receipts.join("operation-receipts.sqlite");
    std::fs::write(&sqlite, b"not-a-database").unwrap();
    seal_file(&sqlite);
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

const WSS_TEST_DEVICE: &str = "f4e1e64e-1e72-410e-8b51-181818181818";

fn accept_disposable(listener: &TcpListener) -> TcpStream {
    common::accept_windows_loopback(listener)
}

// tungstenite's server callback uses a large, library-defined HTTP error.
#[allow(clippy::result_large_err)]
fn signed_disposable_socket(listener: &TcpListener) -> WebSocket<TcpStream> {
    let mut http = accept_disposable(listener);
    let mut reader = BufReader::new(http.try_clone().unwrap());
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    assert!(first.starts_with("POST /agent/session/challenge HTTP/1.1"));
    let mut body_len = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        if line.to_ascii_lowercase().starts_with("content-length:") {
            body_len = line.split(':').nth(1).unwrap().trim().parse().unwrap();
        }
    }
    let mut body = vec![0; body_len];
    reader.read_exact(&mut body).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["device_id"],
        WSS_TEST_DEVICE
    );
    let response = json!({
        "device_id": WSS_TEST_DEVICE,
        "nonce": "ABCDEFGHIJKLMNOPQRSTUVWX",
    })
    .to_string();
    write!(
        http,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
        response.len()
    )
    .unwrap();
    let ws = accept_disposable(listener);
    tungstenite::accept_hdr(ws, |request: &Request, mut reply: Response| {
        let protocols = request
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(protocols.starts_with("rc-v2, rcv2."));
        reply
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, "rc-v2".parse().unwrap());
        Ok(reply)
    })
    .unwrap()
}

#[test]
fn signed_windows_wss_file_write_read_and_receipt_are_durable() {
    // Actual Win32 ACL validation is exercised before an authenticated socket
    // admits writes. The mock Worker never touches a production Owner or key.
    let root = tempfile::tempdir().unwrap();
    seal_dir(root.path());
    let receipts = root.path().join("receipts");
    let target = root.path().join("wss-file.txt");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server_target = target.clone();
    let server = thread::spawn(move || {
        let mut socket = signed_disposable_socket(&listener);
        for (request_id, content, expected) in [
            ("11111111-1111-1111-1111-111111111111", "once", "completed"),
            ("22222222-2222-2222-2222-222222222222", "once", "completed"),
            (
                "33333333-3333-3333-3333-333333333333",
                "changed",
                "conflict",
            ),
        ] {
            socket
                .send(Message::Text(
                    json!({
                        "kind": "operation",
                        "request_id": request_id,
                        "operation_id": "same-win-op",
                        "tool": "write_file",
                        "arguments": {
                            "path": server_target,
                            "content": content,
                            "mode": "rewrite"
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .unwrap();
            let reply: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(reply["kind"], "operation_result");
            assert_eq!(reply["request_id"], request_id);
            assert_eq!(reply["result"]["status"], expected);
            if content == "once" && request_id.starts_with("11111111") {
                // A same-ID retry must not rewrite external changes. A stable
                // final byte string alone would not detect a replayed write.
                assert_eq!(std::fs::read_to_string(&server_target).unwrap(), "once");
                std::fs::write(&server_target, "external-sentinel").unwrap();
            }
        }
        socket
            .send(Message::Text(
                json!({
                    "kind": "read",
                    "request_id": "44444444-4444-4444-4444-444444444444",
                    "tool": "read_file",
                    "arguments": {"path": server_target}
                })
                .to_string()
                .into(),
            ))
            .unwrap();
        let reply: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(reply["kind"], "read_result");
        assert_eq!(reply["status"], "completed");
        assert_eq!(reply["text"], "external-sentinel");

        server_stop.store(true, Ordering::Release);
    });
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        WSS_TEST_DEVICE,
        &receipts,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "external-sentinel"
    );
    let receipt = ReceiptStore::open(&receipts)
        .unwrap()
        .get("same-win-op")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, "completed");
}

#[test]
fn broad_windows_acl_rejects_wss_admission_before_challenge() {
    let root = tempfile::tempdir().unwrap();
    broad_grant(root.path(), true);
    let receipts = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        WSS_TEST_DEVICE,
        &receipts,
        &Arc::new(AtomicBool::new(false)),
        HeartbeatTiming::default(),
    );
    assert!(
        matches!(
            result,
            Err(NativeFileError::Write(NativeWriteError::Receipt(
                ReceiptError::UnsafePath
            )))
        ),
        "{result:?}"
    );
    listener.set_nonblocking(true).unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(!receipts.join("operation-receipts.sqlite").exists());
}
