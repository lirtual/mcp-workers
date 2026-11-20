//! Signed loopback WSS + native read/write + durable SQLite receipts.
mod common;
use rca_native_agent::native_file::run_native_file_session;
use rca_native_agent::receipts::ReceiptStore;
use rca_native_agent::session::{HeartbeatTiming, SessionError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::protocol::{Message, WebSocket};

const DEVICE_ID: &str = "f4e1e64e-1e72-410e-8b51-181818181818";
fn challenge(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    assert!(first.starts_with("POST /agent/session/challenge HTTP/1.1"));
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        if line.to_ascii_lowercase().starts_with("content-length:") {
            content_length = line.split(':').nth(1).unwrap().trim().parse().unwrap();
        }
    }
    let mut request_body = vec![0u8; content_length];
    reader.read_exact(&mut request_body).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&request_body).unwrap()["device_id"],
        DEVICE_ID
    );
    let body = json!({"device_id":DEVICE_ID,"nonce":"ABCDEFGHIJKLMNOPQRSTUVWX"}).to_string();
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
}
#[allow(clippy::result_large_err)]
fn signed_socket(listener: TcpListener) -> WebSocket<TcpStream> {
    let (http, _) = listener.accept().unwrap();
    challenge(http);
    let (ws, _) = listener.accept().unwrap();
    ws.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    tungstenite::accept_hdr(ws, |request: &Request, mut response: Response| {
        assert!(request
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("rc-v2, rcv2."));
        response
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, "rc-v2".parse().unwrap());
        Ok(response)
    })
    .unwrap()
}
fn request(request_id: &str, tool: &str, operation_id: &str, args: Value) -> String {
    json!({"kind":"operation","request_id":request_id,"operation_id":operation_id,"tool":tool,"arguments":args}).to_string()
}
#[test]
fn signed_file_session_writes_reads_reuses_receipt_and_detects_conflict() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let target = root.path().join("example.txt");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let end = Arc::clone(&stop);
    let server_target = target.clone();
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        for (request_id, body, expected) in [
            ("11111111-1111-1111-1111-111111111111", "once", "completed"),
            ("22222222-2222-2222-2222-222222222222", "once", "completed"),
            ("33333333-3333-3333-3333-333333333333", "twice", "conflict"),
        ] {
            socket
                .send(Message::Text(
                    request(
                        request_id,
                        "write_file",
                        "same-op",
                        json!({"path":server_target,"content":body,"mode":"rewrite"}),
                    )
                    .into(),
                ))
                .unwrap();
            let reply: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(reply["kind"], "operation_result");
            assert_eq!(reply["request_id"], request_id);
            assert_eq!(reply["result"]["status"], expected);
        }
        socket.send(Message::Text(json!({"kind":"read","request_id":"44444444-4444-4444-4444-444444444444","tool":"read_file","arguments":{"path":server_target}}).to_string().into())).unwrap();
        let read: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(read["kind"], "read_result");
        assert_eq!(read["status"], "completed");
        assert_eq!(read["text"], "once");
        socket
            .send(Message::Text(
                request(
                    "55555555-5555-5555-5555-555555555555",
                    "get_operation_status",
                    "same-op",
                    json!({"operation_id":"same-op"}),
                )
                .into(),
            ))
            .unwrap();
        let status: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(status["result"]["status"], "completed");
        assert_eq!(status["result"]["receipt"]["tool_name"], "write_file");
        end.store(true, Ordering::Release);
    });
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "once");
    let receipt = ReceiptStore::open(&receipt_dir)
        .unwrap()
        .get("same-op")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.state, "completed");
}

#[test]
fn signed_file_session_rejects_non_file_mutation_with_policy_1008() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        socket
            .send(Message::Text(
                request(
                    "11111111-1111-1111-1111-111111111111",
                    "start_process",
                    "never",
                    json!({"command":"echo hi"}),
                )
                .into(),
            ))
            .unwrap();
        match socket.read().unwrap() {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("expected policy close, got {other:?}"),
        }
    });
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(
            result,
            Err(rca_native_agent::native_file::NativeFileError::Session(
                SessionError::Policy
            ))
        ),
        "{result:?}"
    );
    assert!(ReceiptStore::open(&receipt_dir)
        .unwrap()
        .get("never")
        .unwrap()
        .is_none());
}

#[test]
fn revoke_cleanup_cancels_native_file_session_without_claiming_process_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let target = root.path().join("must-not-exist.txt");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        socket.send(Message::Text(json!({"kind":"revoke_cleanup","request_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}).to_string().into())).unwrap();
        let reply: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(reply["kind"], "revoke_cleanup_result");
        assert_eq!(reply["status"], "uncertain");
    });
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(
            result,
            Err(rca_native_agent::native_file::NativeFileError::Session(
                SessionError::Policy
            ))
        ),
        "{result:?}"
    );
    assert!(!target.exists());
}

#[test]
fn invalid_write_arguments_close_1008_without_receipt_admission() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let target = root.path().join("never-written.txt");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server_target = target.clone();
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        socket
            .send(Message::Text(
                request(
                    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "write_file",
                    "bad-write",
                    json!({"path":server_target,"content":"x","mode":"overwrite"}),
                )
                .into(),
            ))
            .unwrap();
        match socket.read().unwrap() {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("expected policy close, got {other:?}"),
        }
    });
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(
            result,
            Err(rca_native_agent::native_file::NativeFileError::Session(
                SessionError::Policy
            ))
        ),
        "{result:?}"
    );
    assert!(!target.exists());
    assert!(ReceiptStore::open(&receipt_dir)
        .unwrap()
        .get("bad-write")
        .unwrap()
        .is_none());
}
