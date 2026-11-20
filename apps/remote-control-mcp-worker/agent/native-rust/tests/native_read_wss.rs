//! Signed loopback Worker proof: the real bounded queue executes read_file
//! while malformed frames never reach local IO and close the socket as 1008.
use rca_native_agent::native_read::{run_native_read_session, NativeReadRuntimeError};
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
use tungstenite::{Message, WebSocket};

mod common;
const DEVICE_ID: &str = "12345678-1234-1234-1234-123456789abc";
const REQUEST_ID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
fn challenge(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
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
        let offered = request
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(offered.starts_with("rc-v2, rcv2."));
        response
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, "rc-v2".parse().unwrap());
        Ok(response)
    })
    .unwrap()
}
fn read_request(path: &str) -> String {
    json!({"kind":"read","request_id":REQUEST_ID,"tool":"read_file",
        "arguments":{"path":path,"offset":0,"length":2}})
    .to_string()
}
#[test]
fn signed_wss_read_file_matches_node_reference_with_real_file_and_bounded_queue() {
    let folder = tempfile::tempdir().unwrap();
    let file = folder.path().join("fixture.txt");
    std::fs::write(&file, "line-one\nline-two\nline-three\n").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let worker = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        socket
            .send(Message::Text(
                json!({"kind":"read","request_id":REQUEST_ID,
            "tool":"read_file","arguments":{"path":"file:///etc/hostname"}})
                .to_string()
                .into(),
            ))
            .unwrap();
        let failed: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(failed["status"], "failed");
        assert!(failed.get("text").is_none());
        // A valid read follows on the *same signed socket*, without re-admission.
        socket
            .send(Message::Text(read_request(file.to_str().unwrap()).into()))
            .unwrap();
        let wire = socket.read().unwrap().into_text().unwrap();
        let result: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(result["kind"], "read_result");
        assert_eq!(result["request_id"], REQUEST_ID);
        assert_eq!(result["status"], "completed");
        assert_eq!(result["text"], "line-one\nline-two");
        worker_stop.store(true, Ordering::Release);
    });
    let result = run_native_read_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &stop,
        HeartbeatTiming::default(),
    );
    worker.join().unwrap();
    assert!(result.is_ok(), "{result:?}");
}
#[test]
fn malformed_remote_operation_closes_1008_without_writing_file() {
    let folder = tempfile::tempdir().unwrap();
    let file = folder.path().join("safety.txt");
    std::fs::write(&file, "unchanged").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let file_for_worker = file.clone();
    let worker = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        socket
            .send(Message::Text(
                json!({"kind":"operation","request_id":REQUEST_ID,
            "operation_id":"test-write","tool":"write_file",
            "arguments":{"path":file_for_worker,"content":"mutated","mode":"rewrite"}})
                .to_string()
                .into(),
            ))
            .unwrap();
        let close = socket.read().unwrap();
        match close {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("expected policy close 1008, got {other:?}"),
        }
    });
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_native_read_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &stop,
        HeartbeatTiming::default(),
    );
    worker.join().unwrap();
    assert!(
        matches!(
            result,
            Err(NativeReadRuntimeError::Session(SessionError::Policy))
        ),
        "{result:?}"
    );
    assert_eq!(std::fs::read_to_string(file).unwrap(), "unchanged");
}

#[cfg(unix)]
#[test]
fn authenticated_transport_executes_disposable_write_with_durable_receipt_only_once() {
    use rca_native_agent::gate0_probe::Gate0Probe;
    use rca_native_agent::native_file::run_disposable_file_session;
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::Builder::new()
        .prefix("rca-rust-probe-")
        .tempdir()
        .unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let target = root.path().join("probe.txt");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let target_for_worker = target.clone();
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        for (request_id, content, expected) in [
            ("11111111-1111-1111-1111-111111111111", "once", "completed"),
            ("22222222-2222-2222-2222-222222222222", "once", "completed"),
            (
                "33333333-3333-3333-3333-333333333333",
                "changed",
                "conflict",
            ),
        ] {
            let request = json!({"kind":"operation","request_id":request_id,
                "operation_id":"one-test-effect","tool":"write_file",
                "arguments":{"path":target_for_worker,"content":content,"mode":"rewrite"}})
            .to_string();
            socket.send(Message::Text(request.into())).unwrap();
            let reply: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(reply["request_id"], request_id);
            assert_eq!(reply["result"]["status"], expected);
        }
        socket
            .send(Message::Text(
                json!({"kind":"read","request_id":REQUEST_ID,
            "tool":"read_file","arguments":{"path":target_for_worker}})
                .to_string()
                .into(),
            ))
            .unwrap();
        let reply: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(reply["status"], "completed");
        assert_eq!(reply["text"], "once");
        worker_stop.store(true, Ordering::Release);
    });
    let result = run_disposable_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        root.path(),
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "once");
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let mut reopened = Gate0Probe::new(root.path()).unwrap();
    let status = reopened
        .handle(
            &json!({"kind":"operation",
        "request_id":"44444444-4444-4444-4444-444444444444",
        "operation_id":"one-test-effect","tool":"get_operation_status",
        "arguments":{"operation_id":"one-test-effect"}})
            .to_string(),
        )
        .unwrap();
    let persisted: Value = serde_json::from_str(&status).unwrap();
    assert_eq!(persisted["result"]["status"], "completed");
    assert_eq!(persisted["result"]["receipt"]["tool_name"], "write_file");
}

#[cfg(unix)]
#[test]
fn disposable_file_session_revocation_closes_before_any_target_write() {
    use rca_native_agent::native_file::{run_disposable_file_session, DisposableFileError};
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::Builder::new()
        .prefix("rca-rust-probe-")
        .tempdir()
        .unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let target = root.path().join("probe.txt");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        socket
            .send(Message::Text(
                json!({"kind":"revoke_cleanup","request_id":REQUEST_ID})
                    .to_string()
                    .into(),
            ))
            .unwrap();
        let reply: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(reply["kind"], "revoke_cleanup_result");
        assert_eq!(reply["status"], "uncertain");
    });
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_disposable_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        root.path(),
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(
            result,
            Err(DisposableFileError::Session(SessionError::Policy))
        ),
        "{result:?}"
    );
    assert!(!target.exists(), "revoked session must not start a write");
}

#[cfg(unix)]
#[test]
fn disposable_file_runtime_rejects_unsafe_root_before_network_access() {
    use rca_native_agent::gate0_probe::ProbeError;
    use rca_native_agent::native_file::{run_disposable_file_session, DisposableFileError};
    let ordinary = tempfile::tempdir().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_disposable_file_session(
        "http://127.0.0.1:9/",
        &common::test_pem(),
        DEVICE_ID,
        ordinary.path(),
        &stop,
        HeartbeatTiming::default(),
    );
    assert!(
        matches!(
            result,
            Err(DisposableFileError::Probe(ProbeError::UnsafeRoot))
        ),
        "{result:?}"
    );
    assert!(!stop.load(Ordering::Acquire));
}
