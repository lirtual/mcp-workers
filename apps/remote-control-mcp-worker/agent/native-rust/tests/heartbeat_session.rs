//! Existing Worker rc-v2 contract through a real signed loopback challenge/WSS.
//! This tests transport framing, not durable grant revocation inside the DO.
use rca_native_agent::session::{connect_authenticated, HeartbeatTiming, SessionError};
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
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
