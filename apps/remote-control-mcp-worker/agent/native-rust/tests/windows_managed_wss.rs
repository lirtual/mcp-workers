//! Physical Windows signed WSS: Job-owned command, SQLite receipt dedupe,
//! bounded stdin/output, Owner revocation, and fail-closed command admission.
//! All sockets and commands are disposable; no installed identity or production URL.
#![cfg(windows)]
mod common;

use rca_native_agent::native_file::{run_native_managed_session, NativeFileError};
use rca_native_agent::receipts::ReceiptStore;
use rca_native_agent::session::{HeartbeatTiming, SessionError};
use rca_native_agent::windows_job::JobCleanup;
use rca_native_agent::windows_managed::{SessionState, WindowsManagedSessions};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::protocol::{Message, WebSocket};

const DEVICE_ID: &str = "f4e1e64e-1e72-410e-8b51-181818181818";

// A server-side assertion failure must stop client reconnects so the test
// reports the original mismatch rather than waiting for the CI timeout.
struct StopOnPanic(Arc<AtomicBool>);

impl Drop for StopOnPanic {
    fn drop(&mut self) {
        if thread::panicking() {
            self.0.store(true, Ordering::Release);
        }
    }
}

fn challenge(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    assert!(first.starts_with("POST /agent/session/challenge HTTP/1.1"));
    let mut len = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        if line.to_ascii_lowercase().starts_with("content-length:") {
            len = line.split(':').nth(1).unwrap().trim().parse().unwrap();
        }
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["device_id"],
        DEVICE_ID
    );
    let response = json!({"device_id":DEVICE_ID,"nonce":"ABCDEFGHIJKLMNOPQRSTUVWX"}).to_string();
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
}

#[allow(clippy::result_large_err)]
fn signed_socket(listener: TcpListener) -> WebSocket<TcpStream> {
    let (http, _) = listener.accept().unwrap();
    challenge(http);
    let (ws, _) = listener.accept().unwrap();
    ws.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
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

fn operation(id: &str, tool: &str, args: Value) -> String {
    json!({"kind":"operation","request_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "operation_id":id,"tool":tool,"arguments":args})
    .to_string()
}
fn reply(socket: &mut WebSocket<TcpStream>, frame: String) -> Value {
    socket.send(Message::Text(frame.into())).unwrap();
    serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap()
}
fn read(socket: &mut WebSocket<TcpStream>, tool: &str, args: Value) -> Value {
    reply(
        socket,
        json!({"kind":"read","request_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "tool":tool,"arguments":args})
        .to_string(),
    )
}
fn registry() -> Arc<WindowsManagedSessions> {
    Arc::new(WindowsManagedSessions::new(Duration::from_secs(15)).unwrap())
}

#[test]
fn signed_windows_start_input_output_receipt_and_owner_revoke() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let _stop_on_panic = StopOnPanic(Arc::clone(&server_stop));
        let mut socket = signed_socket(listener);
        // The genuine PowerShell redirected streams may contain CLIXML progress.
        // The exact byte sentinel, not a stream-wide equality, is the contract.
        let command = "$stdin=[Console]::OpenStandardInput();$stdout=[Console]::OpenStandardOutput();$buffer=New-Object byte[] 19;$read=$stdin.Read($buffer,0,19);$stdout.Write($buffer,0,$read);$stdout.Flush()";
        let args = json!({"command":command,"timeout_ms":0});
        let first = reply(
            &mut socket,
            operation("win-wss-start", "start_process", args.clone()),
        );
        assert_eq!(first["result"]["status"], "running");
        let sid = first["result"]["session_id"].as_str().unwrap().to_owned();
        let same = reply(
            &mut socket,
            operation("win-wss-start", "start_process", args),
        );
        assert_eq!(same["result"]["session_id"], sid);
        let input = json!({"session_id":sid,"input":"stdin-roundtrip-914"});
        let sent = reply(
            &mut socket,
            operation("win-wss-input", "interact_with_process", input.clone()),
        );
        assert_eq!(sent["result"]["status"], "completed");
        assert_eq!(
            reply(
                &mut socket,
                operation("win-wss-input", "interact_with_process", input)
            )["result"]["status"],
            "completed"
        );
        assert_eq!(
            reply(
                &mut socket,
                operation(
                    "win-wss-input",
                    "interact_with_process",
                    json!({"session_id":sid,"input":"different"})
                )
            )["result"]["status"],
            "conflict"
        );
        let deadline = Instant::now() + Duration::from_secs(8);
        let output = loop {
            let result = read(
                &mut socket,
                "read_process_output",
                json!({"session_id":sid,"length":8192}),
            );
            assert_eq!(result["status"], "completed");
            let page: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
            if page["state"] == "completed"
                && page["eof"] == true
                && page["output"]
                    .as_str()
                    .unwrap()
                    .contains("stdin-roundtrip-914")
            {
                break page;
            }
            assert!(
                Instant::now() < deadline,
                "signed Windows command did not reach confirmed EOF: {page}"
            );
            thread::sleep(Duration::from_millis(25));
        };
        assert_eq!(output["exit_code"], 0);
        let status = reply(
            &mut socket,
            operation(
                "win-wss-start",
                "get_operation_status",
                json!({"operation_id":"win-wss-start"}),
            ),
        );
        assert_eq!(status["result"]["status"], "completed");
        assert_eq!(status["result"]["receipt"]["tool_name"], "start_process");
        let list = read(&mut socket, "list_sessions", json!({}));
        let sessions: Value = serde_json::from_str(list["text"].as_str().unwrap()).unwrap();
        assert_eq!(sessions.as_array().unwrap().len(), 1);
        assert_eq!(
            read(
                &mut socket,
                "read_process_output",
                json!({"session_id":sid,"length":65537})
            )["status"],
            "failed"
        );
        let revoke = reply(
            &mut socket,
            json!({"kind":"revoke_cleanup","request_id":"cccccccc-cccc-cccc-cccc-cccccccccccc"})
                .to_string(),
        );
        assert_eq!(revoke["status"], "confirmed");
        server_stop.store(true, Ordering::Release);
    });
    let managed = registry();
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        Arc::clone(&managed),
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(result, Err(NativeFileError::Session(SessionError::Policy))),
        "{result:?}"
    );
    let state = managed.list();
    assert_eq!(state.len(), 1);
    assert_eq!(state[0].state, SessionState::Completed);
    assert_eq!(state[0].cleanup, Some(JobCleanup::Confirmed));
    let receipt = ReceiptStore::open(&receipt_dir)
        .unwrap()
        .get("win-wss-start")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, "completed");
}

#[test]
fn owner_revoke_stops_active_windows_job_before_confirmed_ack() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let _stop_on_panic = StopOnPanic(Arc::clone(&server_stop));
        let mut socket = signed_socket(listener);
        let start = reply(
            &mut socket,
            operation(
                "win-wss-revoke",
                "start_process",
                json!({"command":"Start-Sleep -Seconds 15","timeout_ms":0}),
            ),
        );
        assert_eq!(start["result"]["status"], "running");
        let ack = reply(
            &mut socket,
            json!({"kind":"revoke_cleanup","request_id":"cccccccc-cccc-cccc-cccc-cccccccccccc"})
                .to_string(),
        );
        assert_eq!(ack["status"], "confirmed");
    });
    let managed = registry();
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        Arc::clone(&managed),
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(result, Err(NativeFileError::Session(SessionError::Policy))),
        "{result:?}"
    );
    assert!(managed
        .list()
        .iter()
        .all(|s| s.state != SessionState::Running && s.cleanup == Some(JobCleanup::Confirmed)));
    assert_eq!(
        ReceiptStore::open(&receipt_dir)
            .unwrap()
            .get("win-wss-revoke")
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );
}

#[test]
fn invalid_windows_process_command_is_rejected_without_receipt_or_launch() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let _stop_on_panic = StopOnPanic(Arc::clone(&server_stop));
        let mut socket = signed_socket(listener);
        socket
            .send(Message::Text(
                operation(
                    "win-never",
                    "start_process",
                    json!({"command":"Write-Output forbidden","extra":true}),
                )
                .into(),
            ))
            .unwrap();
        match socket.read().unwrap() {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("expected WSS 1008, got {other:?}"),
        }
    });
    let managed = registry();
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        Arc::clone(&managed),
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(result, Err(NativeFileError::Session(SessionError::Policy))),
        "{result:?}"
    );
    assert!(managed.list().is_empty());
    assert!(ReceiptStore::open(&receipt_dir)
        .unwrap()
        .get("win-never")
        .unwrap()
        .is_none());
}

#[test]
fn explicit_force_terminate_confirms_windows_job_and_receipt() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let _stop_on_panic = StopOnPanic(Arc::clone(&server_stop));
        let mut socket = signed_socket(listener);
        let start = reply(
            &mut socket,
            operation(
                "win-wss-stop-start",
                "start_process",
                json!({"command":"Start-Sleep -Seconds 15","timeout_ms":0}),
            ),
        );
        assert_eq!(start["result"]["status"], "running");
        let sid = start["result"]["session_id"].as_str().unwrap().to_owned();
        let terminate = json!({"session_id":sid});
        let stop = reply(
            &mut socket,
            operation("win-wss-stop", "force_terminate", terminate.clone()),
        );
        assert_eq!(stop["result"]["status"], "completed");
        assert_eq!(
            reply(
                &mut socket,
                operation("win-wss-stop", "force_terminate", terminate)
            )["result"]["status"],
            "completed"
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let list = read(&mut socket, "list_sessions", json!({}));
            let sessions: Value = serde_json::from_str(list["text"].as_str().unwrap()).unwrap();
            if sessions[0]["state"] == "completed" {
                break;
            }
            assert!(Instant::now() < deadline, "force_terminate never completed");
            thread::sleep(Duration::from_millis(25));
        }
        let revoke = reply(
            &mut socket,
            json!({"kind":"revoke_cleanup","request_id":"cccccccc-cccc-cccc-cccc-cccccccccccc"})
                .to_string(),
        );
        assert_eq!(revoke["status"], "confirmed");
    });
    let managed = registry();
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        Arc::clone(&managed),
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(result, Err(NativeFileError::Session(SessionError::Policy))),
        "{result:?}"
    );
    assert!(managed
        .list()
        .iter()
        .all(|s| s.state == SessionState::Completed && s.cleanup == Some(JobCleanup::Confirmed)));
    assert_eq!(
        ReceiptStore::open(&receipt_dir)
            .unwrap()
            .get("win-wss-stop")
            .unwrap()
            .unwrap()
            .state,
        "completed"
    );
}
