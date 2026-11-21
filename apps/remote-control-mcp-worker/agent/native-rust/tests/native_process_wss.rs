//! Signed rc-v2 loopback: one SQLite owner, owned C-supervised command,
//! no-replay operation receipts, and truthful Owner cleanup acknowledgements.
#![cfg(target_os = "linux")]
mod common;

use rca_native_agent::linux_managed::LinuxManagedSessions;
use rca_native_agent::native_file::{run_native_managed_session, NativeFileError};
use rca_native_agent::receipts::ReceiptStore;
use rca_native_agent::session::{HeartbeatTiming, SessionError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::protocol::{Message, WebSocket};

const DEVICE_ID: &str = "f4e1e64e-1e72-410e-8b51-181818181818";

fn managed() -> Arc<LinuxManagedSessions> {
    let helper = std::env::var("RCA_NATIVE_SUPERVISOR_BIN").expect("real C helper required");
    assert!(Path::new(&helper).is_file());
    Arc::new(
        LinuxManagedSessions::new(
            Path::new(&helper),
            Path::new("/bin/sh"),
            Duration::from_secs(10),
        )
        .unwrap(),
    )
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

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn signed_managed_process_start_input_read_receipt_and_revoke() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let end = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        let args = json!({"command":"IFS= read -r v; printf '%s' \"$v\"","timeout_ms":0});
        let first = reply(
            &mut socket,
            operation("p-wss-start", "start_process", args.clone()),
        );
        assert_eq!(first["result"]["status"], "running");
        let sid = first["result"]["session_id"].as_str().unwrap().to_owned();
        let same = reply(&mut socket, operation("p-wss-start", "start_process", args));
        assert_eq!(same["result"]["session_id"], sid);
        let input = json!({"session_id":sid,"input":"中😀\n"});
        let sent = reply(
            &mut socket,
            operation("p-wss-input", "interact_with_process", input.clone()),
        );
        assert_eq!(sent["result"]["status"], "completed");
        assert_eq!(
            reply(
                &mut socket,
                operation("p-wss-input", "interact_with_process", input)
            )["result"]["status"],
            "completed"
        );
        assert_eq!(
            reply(
                &mut socket,
                operation(
                    "p-wss-input",
                    "interact_with_process",
                    json!({"session_id":sid,"input":"different\n"})
                )
            )["result"]["status"],
            "conflict"
        );

        let deadline = Instant::now() + Duration::from_secs(4);
        let output = loop {
            let result = read(
                &mut socket,
                "read_process_output",
                json!({"session_id":sid,"length":256}),
            );
            assert_eq!(result["status"], "completed");
            let page: Value = serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
            if page["state"] == "completed" && page["output"] == "中😀" {
                break page;
            }
            assert!(
                Instant::now() < deadline,
                "process did not complete with expected output"
            );
            thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(output["exit_code"], 0);
        let status = reply(
            &mut socket,
            operation(
                "p-wss-start",
                "get_operation_status",
                json!({"operation_id":"p-wss-start"}),
            ),
        );
        assert_eq!(status["result"]["status"], "completed");
        assert_eq!(status["result"]["receipt"]["tool_name"], "start_process");
        let list = read(&mut socket, "list_sessions", json!({}));
        assert_eq!(list["status"], "completed");
        let sessions: Value = serde_json::from_str(list["text"].as_str().unwrap()).unwrap();
        assert_eq!(sessions.as_array().unwrap().len(), 1);
        let invalid = read(
            &mut socket,
            "read_process_output",
            json!({"session_id":sid,"length":65537}),
        );
        assert_eq!(invalid["status"], "failed");
        let revoke = reply(
            &mut socket,
            json!({"kind":"revoke_cleanup",
            "request_id":"cccccccc-cccc-cccc-cccc-cccccccccccc"})
            .to_string(),
        );
        assert_eq!(revoke["status"], "confirmed");
        end.store(true, Ordering::Release);
    });
    let registry = managed();
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        Arc::clone(&registry),
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(result, Err(NativeFileError::Session(SessionError::Policy))),
        "{result:?}"
    );
    assert_eq!(registry.list().len(), 1);
    let receipt = ReceiptStore::open(&receipt_dir)
        .unwrap()
        .get("p-wss-start")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, "completed");
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn owner_revoke_terminates_active_owned_descendants_before_confirmed_ack() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        let start = reply(
            &mut socket,
            operation(
                "p-wss-revoke",
                "start_process",
                json!({"command":"sleep 30","timeout_ms":0}),
            ),
        );
        assert_eq!(start["result"]["status"], "running");
        let ack = reply(
            &mut socket,
            json!({"kind":"revoke_cleanup",
            "request_id":"cccccccc-cccc-cccc-cccc-cccccccccccc"})
            .to_string(),
        );
        assert_eq!(ack["status"], "confirmed");
    });
    let registry = managed();
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        Arc::clone(&registry),
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(result, Err(NativeFileError::Session(SessionError::Policy))),
        "{result:?}"
    );
    assert!(registry
        .list()
        .iter()
        .all(|entry| entry.state != rca_native_agent::linux_managed::SessionState::Running));
    let receipt = ReceiptStore::open(&receipt_dir)
        .unwrap()
        .get("p-wss-revoke")
        .unwrap()
        .unwrap();
    assert_eq!(
        receipt.state, "completed",
        "confirmed Owner cleanup must be persisted before SQLite owner exits"
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn malformed_process_operation_stays_forbidden_with_policy_close_1008() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        socket
            .send(Message::Text(
                operation(
                    "p-never",
                    "start_process",
                    json!({"command":"printf forbidden","extra":true}),
                )
                .into(),
            ))
            .unwrap();
        match socket.read().unwrap() {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("expected 1008, got {other:?}"),
        }
    });
    let registry = managed();
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        Arc::clone(&registry),
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(result, Err(NativeFileError::Session(SessionError::Policy))),
        "{result:?}"
    );
    assert!(registry.list().is_empty());
    assert!(ReceiptStore::open(&receipt_dir)
        .unwrap()
        .get("p-never")
        .unwrap()
        .is_none());
}
