//! Existing Worker rc-v2 contract through a real signed loopback challenge/WSS.
//! This tests transport framing, not durable grant revocation inside the DO.
use rca_native_agent::session::{
    connect_authenticated, ExecutionRequest, HeartbeatTiming, SessionError,
};
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::{Message, WebSocket};

mod common;
const DEVICE_ID: &str = "12345678-1234-1234-1234-123456789abc";

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
    let mut data = vec![0; length];
    reader.read_exact(&mut data).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&data).unwrap()["device_id"],
        DEVICE_ID
    );
    let body = json!({"device_id":DEVICE_ID,"nonce":"ABCDEFGHIJKLMNOPQRSTUVWX"}).to_string();
    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
}

// Every behavior test must enforce the identical signed protocol handshake.
#[allow(clippy::result_large_err)]
fn accept_signed_socket(listener: TcpListener) -> WebSocket<TcpStream> {
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
        assert!(
            offered.starts_with("rc-v2, rcv2."),
            "signed proof subprotocol missing"
        );
        response
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, "rc-v2".parse().unwrap());
        Ok(response)
    })
    .unwrap()
}

#[test]
fn signed_agent_survives_worker_heartbeat_before_receiving_operation() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let mut socket = accept_signed_socket(listener);
        assert_eq!(socket.read().unwrap().to_text().unwrap(), "rc-v2:ping");
        socket.send(Message::Text("rc-v2:pong".into())).unwrap();
        let request=json!({"kind":"read","tool":"read_file","request_id":"11111111-1111-1111-1111-111111111111","arguments":{"path":"/tmp/safe"}}).to_string();
        socket.send(Message::Text(request.clone().into())).unwrap();
        request
    });
    let mut agent = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    agent
        .set_heartbeat_timing(HeartbeatTiming {
            interval: Duration::from_millis(250),
            timeout: Duration::from_millis(150),
            auth_interval: Duration::from_secs(2),
        })
        .unwrap();
    assert_eq!(agent.receive_text().unwrap(), worker.join().unwrap());
}

#[test]
fn signed_agent_refreshes_worker_grant_with_unique_matching_authorization_probe() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let mut socket = accept_signed_socket(listener);
        let probe = socket.read().unwrap().to_text().unwrap().to_owned();
        let nonce = probe
            .strip_prefix("rc-v2:auth:")
            .expect("existing Worker auth probe prefix");
        assert_eq!(nonce.len(), 32);
        assert!(nonce
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value)));
        socket
            .send(Message::Text(format!("rc-v2:auth-ok:{nonce}").into()))
            .unwrap();
        let request=json!({"kind":"read","tool":"read_file","request_id":"22222222-2222-2222-2222-222222222222","arguments":{"path":"/tmp/authorized"}}).to_string();
        socket.send(Message::Text(request.clone().into())).unwrap();
        request
    });
    let mut agent = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    agent
        .set_heartbeat_timing(HeartbeatTiming {
            interval: Duration::from_secs(2),
            timeout: Duration::from_millis(150),
            auth_interval: Duration::from_millis(250),
        })
        .unwrap();
    assert_eq!(agent.receive_text().unwrap(), worker.join().unwrap());
}

#[test]
fn silent_worker_cannot_satisfy_transport_heartbeat_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let mut socket = accept_signed_socket(listener);
        assert_eq!(socket.read().unwrap().to_text().unwrap(), "rc-v2:ping");
        thread::sleep(Duration::from_millis(400)); // Keep TCP alive, but deliberately omit pong.
    });
    let mut agent = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    agent
        .set_heartbeat_timing(HeartbeatTiming {
            interval: Duration::from_millis(250),
            timeout: Duration::from_millis(150),
            auth_interval: Duration::from_secs(2),
        })
        .unwrap();
    assert!(matches!(
        agent.receive_text(),
        Err(SessionError::HeartbeatTimeout)
    ));
    worker.join().unwrap();
}

#[test]
fn stale_authorization_ack_cannot_satisfy_current_nonce_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let mut socket = accept_signed_socket(listener);
        let probe = socket.read().unwrap().to_text().unwrap().to_owned();
        assert!(probe.starts_with("rc-v2:auth:"));
        socket
            .send(Message::Text(
                format!("rc-v2:auth-ok:{}", "0".repeat(32)).into(),
            ))
            .unwrap();
        thread::sleep(Duration::from_millis(400)); // Wrong nonce cannot clear pending deadline.
    });
    let mut agent = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    agent
        .set_heartbeat_timing(HeartbeatTiming {
            interval: Duration::from_secs(2),
            timeout: Duration::from_millis(150),
            auth_interval: Duration::from_millis(250),
        })
        .unwrap();
    assert!(matches!(
        agent.receive_text(),
        Err(SessionError::AuthorizationTimeout)
    ));
    worker.join().unwrap();
}

#[test]
fn worker_policy_close_must_not_be_treated_as_reconnectable_transport_error() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let mut socket = accept_signed_socket(listener);
        socket
            .send(Message::Close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "revoked".into(),
            })))
            .unwrap();
    });
    let mut agent = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    assert!(matches!(agent.receive_text(), Err(SessionError::Policy)));
    worker.join().unwrap();
}

#[test]
fn transport_heartbeat_and_grant_probe_run_while_an_operation_is_busy() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let mut socket = accept_signed_socket(listener);
        let request=json!({"kind":"operation","request_id":"33333333-3333-3333-3333-333333333333","operation_id":"test-long-operation","tool":"write_file","arguments":{"path":"/tmp/probe","content":"once","mode":"rewrite"}}).to_string();
        socket.send(Message::Text(request.into())).unwrap();
        let mut pings = 0usize;
        let mut auths = 0usize;
        loop {
            let incoming = socket.read().unwrap().to_text().unwrap().to_owned();
            if incoming == "rc-v2:ping" {
                pings += 1;
                socket.send(Message::Text("rc-v2:pong".into())).unwrap();
            } else if let Some(nonce) = incoming.strip_prefix("rc-v2:auth:") {
                auths += 1;
                socket
                    .send(Message::Text(format!("rc-v2:auth-ok:{nonce}").into()))
                    .unwrap();
            } else {
                let output: serde_json::Value = serde_json::from_str(&incoming).unwrap();
                assert_eq!(output["kind"], "operation_result");
                assert!(
                    pings >= 1 && auths >= 1,
                    "heartbeat and Grant checks must continue through a slow operation"
                );
                server_stop.store(true, Ordering::SeqCst);
                return;
            }
        }
    });
    let (requests_tx, requests_rx) = mpsc::sync_channel::<ExecutionRequest>(4);
    let (answers_tx, answers_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let request = requests_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(request.frame_if_active().unwrap()).unwrap()
                ["kind"],
            "operation"
        );
        thread::sleep(Duration::from_millis(700));
        assert!(request.lease().is_active());
        answers_tx.send(request.response(json!({"kind":"operation_result","request_id":"33333333-3333-3333-3333-333333333333","result":{"operation_id":"test-long-operation","status":"completed"}}).to_string())).unwrap();
    });
    let mut agent = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    agent
        .set_heartbeat_timing(HeartbeatTiming {
            interval: Duration::from_millis(250),
            timeout: Duration::from_millis(150),
            auth_interval: Duration::from_millis(350),
        })
        .unwrap();
    agent.pump(&stop, &requests_tx, &answers_rx).unwrap();
    worker.join().unwrap();
    server.join().unwrap();
}

#[test]
fn policy_close_revokes_queued_write_before_executor_starts() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut socket = accept_signed_socket(listener);
        socket
            .send(Message::Text(json!({"kind":"operation","tool":"write_file","request_id":"44444444-4444-4444-4444-444444444444"}).to_string().into()))
            .unwrap();
        thread::sleep(Duration::from_millis(200)); // Ensure the command entered the queue.
        socket
            .send(Message::Close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "grant revoked".into(),
            })))
            .unwrap();
    });
    let (requests_tx, requests_rx) = mpsc::sync_channel::<ExecutionRequest>(4);
    let (_answers_tx, answers_rx) = mpsc::channel();
    let mut agent = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    let stop = AtomicBool::new(false);
    assert!(matches!(
        agent.pump(&stop, &requests_tx, &answers_rx),
        Err(SessionError::Policy)
    ));
    let queued = requests_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        queued.frame_if_active().is_none(),
        "revoked queued write must not begin"
    );
    assert!(
        !queued.lease().is_active(),
        "transport exit must invalidate executor lease"
    );
    server.join().unwrap();
}

#[test]
fn stale_result_from_revoked_socket_is_not_sent_on_replacement_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let mut first = accept_signed_socket(listener.try_clone().unwrap());
        first
            .send(Message::Text(
                json!({"kind":"operation","request_id":"55555555-5555-5555-5555-555555555555"})
                    .to_string()
                    .into(),
            ))
            .unwrap();
        thread::sleep(Duration::from_millis(150));
        first
            .send(Message::Close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "revoked".into(),
            })))
            .unwrap();
        drop(first);
        let mut second = accept_signed_socket(listener);
        second
            .send(Message::Text(
                json!({"kind":"operation","request_id":"66666666-6666-6666-6666-666666666666"})
                    .to_string()
                    .into(),
            ))
            .unwrap();
        let response = second.read().unwrap().to_text().unwrap().to_string();
        let value: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(value["request_id"], "66666666-6666-6666-6666-666666666666");
        server_stop.store(true, Ordering::SeqCst);
    });
    let (requests_tx, requests_rx) = mpsc::sync_channel::<ExecutionRequest>(4);
    // Intentionally reuse the outgoing channel across sessions to test isolation.
    let (answers_tx, answers_rx) = mpsc::channel();
    let mut first = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    assert!(matches!(
        first.pump(&stop, &requests_tx, &answers_rx),
        Err(SessionError::Policy)
    ));
    let stale = requests_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(stale.frame_if_active().is_none());
    answers_tx
        .send(
            stale
                .response(json!({"request_id":"55555555-5555-5555-5555-555555555555"}).to_string()),
        )
        .unwrap();

    let worker =
        thread::spawn(move || {
            let fresh = requests_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            assert!(fresh.frame_if_active().is_some());
            answers_tx
                .send(fresh.response(
                    json!({"request_id":"66666666-6666-6666-6666-666666666666"}).to_string(),
                ))
                .unwrap();
        });
    let mut second = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    second.pump(&stop, &requests_tx, &answers_rx).unwrap();
    worker.join().unwrap();
    server.join().unwrap();
}

#[test]
fn worker_revoke_cleanup_revokes_queued_work_and_defaults_to_unconfirmed() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut socket = accept_signed_socket(listener);
        socket.send(Message::Text(json!({"kind":"operation","tool":"write_file","request_id":"77777777-7777-7777-7777-777777777777"}).to_string().into())).unwrap();
        socket.send(Message::Text(json!({"kind":"revoke_cleanup","request_id":"88888888-8888-8888-8888-888888888888"}).to_string().into())).unwrap();
        let receipt: serde_json::Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(
            receipt,
            json!({"kind":"revoke_cleanup_result","request_id":"88888888-8888-8888-8888-888888888888","status":"uncertain"})
        );
        socket
            .send(Message::Close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "revoked".into(),
            })))
            .unwrap();
    });
    let (requests_tx, requests_rx) = mpsc::sync_channel::<ExecutionRequest>(4);
    let (_answers_tx, answers_rx) = mpsc::channel();
    let mut agent = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    let stop = AtomicBool::new(false);
    assert!(matches!(
        agent.pump(&stop, &requests_tx, &answers_rx),
        Err(SessionError::Policy)
    ));
    let queued = requests_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        queued.frame_if_active().is_none(),
        "revocation must fence in-flight and queued writes first"
    );
    assert!(
        requests_rx.try_recv().is_err(),
        "control frame must never queue as a write"
    );
    server.join().unwrap();
}

#[test]
fn verified_local_cleanup_may_be_confirmed_only_by_explicit_callback() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut socket = accept_signed_socket(listener);
        socket.send(Message::Text(json!({"kind":"revoke_cleanup","request_id":"99999999-9999-9999-9999-999999999999"}).to_string().into())).unwrap();
        let receipt: serde_json::Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(receipt["status"], "confirmed");
    });
    let (requests_tx, requests_rx) = mpsc::sync_channel::<ExecutionRequest>(2);
    let (_answers_tx, answers_rx) = mpsc::channel();
    let mut agent = connect_authenticated(&endpoint, &common::test_pem(), DEVICE_ID).unwrap();
    let stop = AtomicBool::new(false);
    let callback = || rca_native_agent::session::CleanupStatus::Confirmed;
    assert!(matches!(
        agent.pump_with_cleanup(&stop, &requests_tx, &answers_rx, callback),
        Err(SessionError::Policy)
    ));
    assert!(requests_rx.try_recv().is_err());
    server.join().unwrap();
}
