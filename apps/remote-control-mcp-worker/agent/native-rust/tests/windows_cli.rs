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
    let marker = disposable.path().join(MARKER);
    fs::write(&marker, "").unwrap();
    common::seal_windows_file(&marker);
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
    common::seal_windows_file(&marker);
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
    common::seal_windows_file(&key);
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

use rca_native_agent::receipts::ReceiptStore;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::protocol::{Message, WebSocket};

static LOCAL_PORT_LOCK: Mutex<()> = Mutex::new(());

struct ScopedChild(Child);
impl Drop for ScopedChild {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[allow(clippy::result_large_err)] // same concrete HTTP handshake error as other WSS fixtures
fn signed_socket(listener: &TcpListener) -> WebSocket<TcpStream> {
    let mut http = common::accept_windows_loopback(listener);
    let mut reader = BufReader::new(http.try_clone().unwrap());
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    assert!(first.starts_with("POST /agent/session/challenge HTTP/1.1"));
    let mut length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        if line.to_ascii_lowercase().starts_with("content-length:") {
            length = line.split(':').nth(1).unwrap().trim().parse().unwrap();
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["device_id"],
        DEVICE
    );
    let response = json!({"device_id":DEVICE,"nonce":"ABCDEFGHIJKLMNOPQRSTUVWX"}).to_string();
    write!(http, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();

    let socket = common::accept_windows_loopback(listener);
    tungstenite::accept_hdr(socket, |req: &Request, mut resp: Response| {
        assert!(req
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("rc-v2, rcv2."));
        resp.headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, "rc-v2".parse().unwrap());
        Ok(resp)
    })
    .unwrap()
}

fn exchange(socket: &mut WebSocket<TcpStream>, request: Value) -> Value {
    socket
        .send(Message::Text(request.to_string().into()))
        .unwrap();
    serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap()
}

fn wait_for_child(child: &mut Child) -> Option<ExitStatus> {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            // Reap the client before joining the test Worker, even when the
            // test fails, so another test cannot inherit a bound 8777 port.
            let _ = child.kill();
            return None;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn real_windows_cli_managed_wss_revoke_stops_job_and_persists_receipt() {
    let _port = LOCAL_PORT_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let disposable = root();
    let key = disposable.path().join("gate0-test-key.pem");
    fs::write(&key, common::test_pem()).unwrap();
    common::seal_windows_file(&key);
    let listener = TcpListener::bind("127.0.0.1:8777").unwrap();
    let server = thread::spawn(move || {
        let mut socket = signed_socket(&listener);
        let started = exchange(
            &mut socket,
            json!({
                "kind":"operation",
                "request_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "operation_id":"win-cli-managed-914",
                "tool":"start_process",
                "arguments":{"command":"Start-Sleep -Seconds 30","timeout_ms":0}
            }),
        );
        assert_eq!(started["result"]["status"], "running", "{started}");
        let revoked = exchange(
            &mut socket,
            json!({
                "kind":"revoke_cleanup",
                "request_id":"cccccccc-cccc-cccc-cccc-cccccccccccc"
            }),
        );
        assert_eq!(revoked["status"], "confirmed", "{revoked}");
    });
    let mut child = ScopedChild(
        Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
            .args(["--local-managed", DEVICE])
            .arg(disposable.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let status = wait_for_child(&mut child.0);
    let server_result = server.join();
    assert_eq!(
        status.as_ref().map(ExitStatus::success),
        Some(true),
        "CLI: {status:?}"
    );
    server_result.unwrap();
    let receipt = ReceiptStore::open(&disposable.path().join("receipts"))
        .unwrap()
        .get("win-cli-managed-914")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, "completed");
}

#[test]
fn windows_file_only_cli_rejects_shell_with_signed_1008() {
    let _port = LOCAL_PORT_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let disposable = root();
    let key = disposable.path().join("gate0-test-key.pem");
    fs::write(&key, common::test_pem()).unwrap();
    common::seal_windows_file(&key);
    let listener = TcpListener::bind("127.0.0.1:8777").unwrap();
    let server = thread::spawn(move || {
        let mut socket = signed_socket(&listener);
        socket
            .send(Message::Text(
                json!({
                    "kind":"operation",
                    "request_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "operation_id":"win-cli-forbidden-914",
                    "tool":"start_process",
                    "arguments":{"command":"Write-Output SHOULD-NOT-RUN","timeout_ms":0}
                })
                .to_string()
                .into(),
            ))
            .unwrap();
        match socket.read().unwrap() {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("file-only CLI did not reject Shell: {other:?}"),
        }
    });
    let mut child = ScopedChild(
        Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
            .args(["--local", DEVICE])
            .arg(disposable.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let status = wait_for_child(&mut child.0);
    let server_result = server.join();
    assert_eq!(
        status.as_ref().map(ExitStatus::success),
        Some(false),
        "CLI: {status:?}"
    );
    server_result.unwrap();
    assert!(ReceiptStore::open(&disposable.path().join("receipts"))
        .unwrap()
        .get("win-cli-forbidden-914")
        .unwrap()
        .is_none());
}
