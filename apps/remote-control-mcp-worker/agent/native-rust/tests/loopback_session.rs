//! Disposable loopback signed-WebSocket tracer: no Worker, Owner Grant or
//! production identity is contacted. This proves the Rust seams can compose,
//! not that the full five-platform Agent is ready.
use rca_native_agent::receipts::{Admission, ReceiptStore};
use rca_native_agent::session::connect_authenticated;
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
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

fn request_for(id: &str, request_id: &str, args: Value) -> String {
    json!({
        "kind":"operation","operation_id":id,"request_id":request_id,
        "tool":"write_file","arguments":args,
    })
    .to_string()
}

// Tungstenite fixes this handshake callback's error type to a large HTTP response.
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
            json!({"path":probe_path,"content":"once"}),
        ),
        request_for(
            "probe-effect",
            "22222222-2222-2222-2222-222222222222",
            json!({"path":probe_path,"content":"once"}),
        ),
        request_for(
            "probe-effect",
            "33333333-3333-3333-3333-333333333333",
            json!({"path":probe_path,"content":"changed"}),
        ),
    ];
    for (index, frame) in requests.iter().enumerate() {
        socket.send(Message::Text(frame.clone().into())).unwrap();
        let received = socket.read().unwrap();
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
    socket.close(None).unwrap();
}

#[test]
fn signed_socket_disposable_write_receipt_and_replay_guard_survive_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("probe.txt");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker_path = target.to_str().unwrap().to_owned();
    let worker = thread::spawn(move || local_worker(listener, worker_path));
    let mut store = ReceiptStore::open(&tmp.path().join("receipts")).unwrap();
    let mut socket = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    assert_eq!(socket.device_id, DEVICE_ID);

    let mut writes = 0;
    for _ in 0..3 {
        let frame = socket.receive_text().unwrap();
        let request: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(request["kind"], "operation");
        assert_eq!(request["tool"], "write_file");
        let args = request["arguments"].clone();
        // This write is an explicitly confined test-only adapter, not a
        // permissive generic filesystem handler or a production tool.
        assert_eq!(args["path"], target.to_str().unwrap());
        let id = request["operation_id"].as_str().unwrap();
        let result = match store.admit(id, "write_file", &args).unwrap() {
            Admission::New(_) => {
                writes += 1;
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&target)
                    .unwrap();
                file.write_all(args["content"].as_str().unwrap().as_bytes())
                    .unwrap();
                file.sync_all().unwrap();
                store
                    .update(id, "completed", "test write done", None, false)
                    .unwrap();
                "completed"
            }
            Admission::Same(receipt) => {
                assert_eq!(receipt.state, "completed");
                "completed"
            }
            Admission::Conflict(_) => "conflict",
            Admission::Full => panic!("unexpected full receipt store"),
        };
        let reply = json!({
            "kind":"operation_result","request_id":request["request_id"],
            "result":{"operation_id":id,"status":result}
        });
        socket.send_text(&reply.to_string()).unwrap();
    }
    drop(socket);
    drop(store);
    worker.join().unwrap();
    assert_eq!(writes, 1);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "once");
    let mut reopened = ReceiptStore::open(&tmp.path().join("receipts")).unwrap();
    assert_eq!(
        reopened.get("probe-effect").unwrap().unwrap().state,
        "completed"
    );
    assert!(matches!(
        reopened
            .admit(
                "probe-effect",
                "write_file",
                &json!({"path":target,"content":"once"})
            )
            .unwrap(),
        Admission::Same(_)
    ));
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
