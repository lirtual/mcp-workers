//! Disposable loopback signed-WebSocket tracer: no Worker, Owner Grant or
//! production identity is contacted. This proves the Rust seams can compose,
//! not that the full five-platform Agent is ready.
#[cfg(unix)]
use rca_native_agent::gate0_probe::Gate0Probe;
use rca_native_agent::session::connect_authenticated;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
#[cfg(unix)]
use tungstenite::Message;

mod common;
const DEVICE_ID: &str = "12345678-1234-1234-1234-123456789abc";
const NONCE: &str = "ABCDEFGHIJKLMNOPQRSTUVWX";
const PROOF: &str =
    "XNSFWbbMsKNoaFInjZPwOeo543Cw3RDICp9di8gFUhlZSksWdzWYp6hnWFoCzAbCm3VAH-mNK1LZCUlbqp_6AQ";

fn respond_challenge(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut start = String::new();
    reader.read_line(&mut start).unwrap();
    assert!(
        start.starts_with("POST /agent/session/challenge HTTP/1.1"),
        "{start}"
    );
    let mut length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        if line.to_ascii_lowercase().starts_with("content-length:") {
            length = line
                .split(':')
                .nth(1)
                .unwrap()
                .trim()
                .parse::<usize>()
                .unwrap();
        }
    }
    assert!(length > 0 && length < 1_024);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"device_id":DEVICE_ID})
    );
    let reply = json!({"device_id":DEVICE_ID,"nonce":NONCE}).to_string();
    let http = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        reply.len(), reply
    );
    stream.write_all(http.as_bytes()).unwrap();
    stream.flush().unwrap();
}

#[cfg(unix)]
fn request_for(id: &str, request_id: &str, args: Value) -> String {
    json!({
        "kind":"operation","operation_id":id,"request_id":request_id,
        "tool":"write_file","arguments":args,
    })
    .to_string()
}

// Tungstenite fixes this handshake callback's error type to a large HTTP response.
#[cfg(unix)]
#[allow(clippy::result_large_err)]
fn local_worker(listener: TcpListener, probe_path: String) {
    let (http, _) = listener.accept().unwrap();
    http.set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    respond_challenge(http);
    let (ws, _) = listener.accept().unwrap();
    ws.set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    let mut socket = tungstenite::accept_hdr(ws, |request: &Request, mut response: Response| {
        assert_eq!(request.uri().path(), format!("/agent/connect/{DEVICE_ID}"));
        let offered = request
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(offered, format!("rc-v2, rcv2.{NONCE}.{PROOF}"));
        response
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, "rc-v2".parse().unwrap());
        Ok(response)
    })
    .unwrap();
    let requests = [
        request_for(
            "probe-effect",
            "11111111-1111-1111-1111-111111111111",
            json!({"path":probe_path,"content":"once","mode":"rewrite"}),
        ),
        request_for(
            "probe-effect",
            "22222222-2222-2222-2222-222222222222",
            json!({"path":probe_path,"content":"once","mode":"rewrite"}),
        ),
        request_for(
            "probe-effect",
            "33333333-3333-3333-3333-333333333333",
            json!({"path":probe_path,"content":"changed","mode":"rewrite"}),
        ),
    ];
    for (index, frame) in requests.iter().enumerate() {
        if index == 0 {
            socket.send(Message::Ping(vec![42].into())).unwrap();
        }
        socket.send(Message::Text(frame.clone().into())).unwrap();
        let received = loop {
            match socket.read().unwrap() {
                Message::Pong(_) => continue,
                result => break result,
            }
        };
        let answer: Value = serde_json::from_str(received.to_text().unwrap()).unwrap();
        assert_eq!(answer["kind"], "operation_result");
        assert_eq!(
            answer["request_id"],
            json!(
                [
                    "11111111-1111-1111-1111-111111111111",
                    "22222222-2222-2222-2222-222222222222",
                    "33333333-3333-3333-3333-333333333333"
                ][index]
            )
        );
        assert_eq!(
            answer["result"]["status"],
            if index == 2 { "conflict" } else { "completed" }
        );
    }
    socket
        .send(Message::Text(
            json!({
                "kind":"read","tool":"read_file",
                "request_id":"66666666-6666-6666-6666-666666666666",
                "arguments":{"path":probe_path}
            })
            .to_string()
            .into(),
        ))
        .unwrap();
    let response: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(response["kind"], "read_result");
    assert_eq!(
        response["request_id"],
        "66666666-6666-6666-6666-666666666666"
    );
    assert_eq!(response["status"], "completed");
    assert_eq!(response["text"], "once");
    socket.close(None).unwrap();
}

#[cfg(unix)]
#[test]
fn signed_socket_disposable_write_receipt_and_replay_guard_survive_restart() {
    let tmp = tempfile::Builder::new()
        .prefix("rca-rust-probe-")
        .tempdir()
        .unwrap();
    // macOS temp paths may use /var, an alias of /private/var. The
    // production-equivalent private-root gate requires its canonical path.
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let target = root.join("probe.txt");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker_path = target.to_str().unwrap().to_owned();
    let worker = thread::spawn(move || local_worker(listener, worker_path));

    // tempfile creates this directory with the process umask; restrict it
    // explicitly before the production-equivalent private-state gate.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut probe = Gate0Probe::new(&root).unwrap();
    let mut socket = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    assert_eq!(socket.device_id, DEVICE_ID);
    for _ in 0..4 {
        let incoming = socket.receive_text().unwrap();
        let response = probe.handle(&incoming).unwrap();
        socket.send_text(&response).unwrap();
    }
    drop(socket);
    drop(probe);
    worker.join().unwrap();

    assert_eq!(std::fs::read_to_string(&target).unwrap(), "once");
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let mut reopened = Gate0Probe::new(&root).unwrap();
    let status = reopened
        .handle(
            &json!({
                "kind":"operation", "tool":"get_operation_status",
                "request_id":"44444444-4444-4444-4444-444444444444",
                "operation_id":"probe-effect",
                "arguments":{"operation_id":"probe-effect"}
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&status).unwrap();
    assert_eq!(parsed["result"]["status"], "completed");
    assert_eq!(parsed["result"]["receipt"]["operation_id"], "probe-effect");
    let duplicate = reopened
        .handle(&request_for(
            "probe-effect",
            "55555555-5555-5555-5555-555555555555",
            json!({"path":target,"content":"once","mode":"rewrite"}),
        ))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&duplicate).unwrap()["result"]["status"],
        "completed"
    );
}

#[test]
fn denied_owner_grant_stops_before_websocket_and_receipt_admission() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let (mut http, _) = listener.accept().unwrap();
        let mut input = [0u8; 2048];
        let n = http.read(&mut input).unwrap();
        assert!(String::from_utf8_lossy(&input[..n]).contains("/agent/session/challenge"));
        http.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
    });
    let outcome = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID);
    assert!(matches!(
        outcome,
        Err(rca_native_agent::session::SessionError::Rejected(403))
    ));
    worker.join().unwrap();
}

#[test]
// Same third-party handshake callback signature; no production error surface.
#[allow(clippy::result_large_err)]
fn worker_cannot_select_the_secret_bearing_websocket_subprotocol() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let (http, _) = listener.accept().unwrap();
        respond_challenge(http);
        let (socket, _) = listener.accept().unwrap();
        let mut ws =
            tungstenite::accept_hdr(socket, |request: &Request, mut response: Response| {
                let offered = request
                    .headers()
                    .get(SEC_WEBSOCKET_PROTOCOL)
                    .unwrap()
                    .to_str()
                    .unwrap();
                let credential = offered.split(", ").nth(1).unwrap();
                response
                    .headers_mut()
                    .insert(SEC_WEBSOCKET_PROTOCOL, credential.parse().unwrap());
                Ok(response)
            })
            .unwrap();
        let _ = ws.close(None);
    });
    let outcome = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID);
    assert!(matches!(
        outcome,
        Err(rca_native_agent::session::SessionError::Protocol)
    ));
    worker.join().unwrap();
}
