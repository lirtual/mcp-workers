//! Opt-in real Rust CLI process -> signed loopback WSS -> real C-supervised
//! command. Verifies SIGTERM, owned process cleanup and persisted SQLite.
#![cfg(any(target_os = "linux", target_os = "macos"))]
mod common;

use rca_native_agent::receipts::ReceiptStore;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc::sync_channel, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::protocol::{Message, WebSocket};

const DEVICE_ID: &str = "f4e1e64e-1e72-410e-8b51-181818181818";
const OPERATION: &str = "cli-managed-term-914";
#[cfg(target_os = "linux")]
const HELPER_ENV: &str = "RCA_NATIVE_SUPERVISOR_BIN";
#[cfg(target_os = "macos")]
const HELPER_ENV: &str = "RCA_DARWIN_SUPERVISOR_BIN";
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

fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                // BSD accepted sockets can inherit O_NONBLOCK from the listener.
                // The signed WebSocket harness requires bounded blocking reads.
                stream.set_nonblocking(false).unwrap();
                return stream;
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < deadline,
                    "CLI did not connect to local WSS"
                );
                thread::sleep(Duration::from_millis(15));
            }
            Err(err) => panic!("local loopback accept failed: {err}"),
        }
    }
}

#[allow(clippy::result_large_err)] // tungstenite requires a concrete HTTP error response
fn socket(listener: &TcpListener) -> WebSocket<TcpStream> {
    let mut http = accept(listener);
    http.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(http.try_clone().unwrap());
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    assert!(first.starts_with("POST /agent/session/challenge HTTP/1.1"));
    let mut length = 0usize;
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
        DEVICE_ID
    );
    let response = json!({"device_id":DEVICE_ID,"nonce":"ABCDEFGHIJKLMNOPQRSTUVWX"}).to_string();
    write!(http,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();

    let ws = accept(listener);
    ws.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    tungstenite::accept_hdr(ws, |req: &Request, mut resp: Response| {
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

fn exchange(ws: &mut WebSocket<TcpStream>, request: Value) -> Value {
    ws.send(Message::Text(request.to_string().into())).unwrap();
    serde_json::from_str(&ws.read().unwrap().into_text().unwrap()).unwrap()
}

#[test]
#[ignore = "requires disposable Unix host with the independently built C supervisor"]
fn real_cli_sigterm_stops_owned_shell_and_persists_confirmed_receipt() {
    let _port = LOCAL_PORT_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let helper = std::env::var(HELPER_ENV).expect("explicit C supervisor required");
    let helper = Path::new(&helper);
    assert!(helper.is_absolute() && helper.is_file());
    let root = tempfile::Builder::new()
        .prefix("rca-rust-probe-cli-managed-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let key = root.path().join("gate0-test-key.pem");
    fs::write(&key, common::test_pem()).unwrap();
    fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();

    let listener = TcpListener::bind("127.0.0.1:8777").unwrap();
    listener.set_nonblocking(true).unwrap();
    let (pid_tx, pid_rx) = sync_channel::<i32>(1);
    let server = thread::spawn(move || {
        let mut ws = socket(&listener);
        common::receive_device_info(&mut ws, true);
        let started = exchange(
            &mut ws,
            json!({
                "kind":"operation",
                "request_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "operation_id":OPERATION,
                "tool":"start_process",
                "arguments":{"command":"printf '%s\\n' $$; sleep 30","timeout_ms":0}
            }),
        );
        assert_eq!(started["result"]["status"], "running", "{started}");
        let sid = started["result"]["session_id"].as_str().unwrap().to_owned();
        let deadline = Instant::now() + Duration::from_secs(5);
        let owned_pid = loop {
            let answer = exchange(
                &mut ws,
                json!({
                    "kind":"read","request_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "tool":"read_process_output","arguments":{"session_id":sid,"length":128}
                }),
            );
            assert_eq!(answer["status"], "completed");
            let page: Value = serde_json::from_str(answer["text"].as_str().unwrap()).unwrap();
            if let Ok(pid) = page["output"].as_str().unwrap_or("").trim().parse::<i32>() {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "owned Shell PID was not observed"
            );
            thread::sleep(Duration::from_millis(25));
        };
        pid_tx.send(owned_pid).unwrap();
        // SIGTERM should close the authenticated socket without claiming
        // an Owner cleanup ACK that was never requested.
        let _ = ws.read();
    });

    let mut child = ScopedChild(
        Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
            .args(["--local-managed", DEVICE_ID])
            .arg(root.path().canonicalize().unwrap())
            .env(HELPER_ENV, helper)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let shell_pid = pid_rx
        .recv_timeout(Duration::from_secs(16))
        .expect("CLI process did not launch an owned Shell");
    assert_eq!(unsafe { libc::kill(shell_pid, 0) }, 0);
    assert_eq!(unsafe { libc::kill(child.0.id() as i32, libc::SIGTERM) }, 0);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(
                status.success(),
                "SIGTERM must stop the CLI cleanly: {status}"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "CLI SIGTERM cleanup exceeded 10s"
        );
        thread::sleep(Duration::from_millis(25));
    }
    server.join().unwrap();
    let dead = unsafe { libc::kill(shell_pid, 0) };
    assert_eq!(dead, -1, "owned Shell remained alive after CLI SIGTERM");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    let receipt = ReceiptStore::open(&root.path().join("receipts"))
        .unwrap()
        .get(OPERATION)
        .unwrap()
        .unwrap();
    assert_eq!(
        receipt.state, "completed",
        "confirmed cleanup must persist before CLI exits"
    );
}

#[test]
#[ignore = "requires disposable Unix host with the independently built C supervisor"]
fn real_cli_owner_revoke_confirms_cleanup_before_exit_and_receipt_close() {
    let _port = LOCAL_PORT_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let helper = std::env::var(HELPER_ENV).expect("explicit C supervisor required");
    let helper = Path::new(&helper);
    assert!(helper.is_absolute() && helper.is_file());
    let root = tempfile::Builder::new()
        .prefix("rca-rust-probe-cli-revoke-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let key = root.path().join("gate0-test-key.pem");
    fs::write(&key, common::test_pem()).unwrap();
    fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();

    let listener = TcpListener::bind("127.0.0.1:8777").unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let mut ws = socket(&listener);
        common::receive_device_info(&mut ws, true);
        let start = exchange(
            &mut ws,
            json!({
                "kind":"operation",
                "request_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "operation_id":"cli-revoke-start-914",
                "tool":"start_process",
                "arguments":{"command":"sleep 30","timeout_ms":0}
            }),
        );
        assert_eq!(start["result"]["status"], "running", "{start}");
        let ack = exchange(
            &mut ws,
            json!({
                "kind":"revoke_cleanup",
                "request_id":"cccccccc-cccc-cccc-cccc-cccccccccccc"
            }),
        );
        assert_eq!(ack["status"], "confirmed", "Owner ACK must await C cleanup");
    });

    let mut child = ScopedChild(
        Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
            .args(["--local-managed", DEVICE_ID])
            .arg(root.path().canonicalize().unwrap())
            .env(HELPER_ENV, helper)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(
                status.success(),
                "Node-compatible Owner policy revoke must end CLI cleanly: {status}"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Owner revoke did not stop native CLI"
        );
        thread::sleep(Duration::from_millis(25));
    }
    server.join().unwrap();
    let receipt = ReceiptStore::open(&root.path().join("receipts"))
        .unwrap()
        .get("cli-revoke-start-914")
        .unwrap()
        .unwrap();
    assert_eq!(
        receipt.state, "completed",
        "Owner cleanup confirmed but final SQLite receipt was not persisted"
    );
}

#[test]
#[ignore = "requires disposable Unix host with a dedicated signed loopback port"]
fn original_file_only_cli_still_rejects_process_frames_and_exits_on_policy() {
    let _port = LOCAL_PORT_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let root = tempfile::Builder::new()
        .prefix("rca-rust-probe-cli-file-only-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let key = root.path().join("gate0-test-key.pem");
    fs::write(&key, common::test_pem()).unwrap();
    fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();

    let listener = TcpListener::bind("127.0.0.1:8777").unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let mut ws = socket(&listener);
        ws.send(Message::Text(
            json!({
                "kind":"operation",
                "request_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "operation_id":"cli-file-only-forbidden",
                "tool":"start_process",
                "arguments":{"command":"printf SHOULD-NOT-RUN","timeout_ms":0}
            })
            .to_string()
            .into(),
        ))
        .unwrap();
        match ws.read().unwrap() {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("file-only CLI did not reject Shell with 1008: {other:?}"),
        }
    });
    let mut child = ScopedChild(
        Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
            .args(["--local", DEVICE_ID])
            .arg(root.path().canonicalize().unwrap())
            .env_remove(HELPER_ENV)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(
                !status.success(),
                "old file-only mode must retain policy error exit"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "file-only CLI did not close on 1008"
        );
        thread::sleep(Duration::from_millis(25));
    }
    server.join().unwrap();
    assert!(
        ReceiptStore::open(&root.path().join("receipts"))
            .unwrap()
            .get("cli-file-only-forbidden")
            .unwrap()
            .is_none(),
        "file-only Shell operation admitted a receipt"
    );
}
