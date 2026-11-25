//! Real signed loopback: no operation replay, fresh challenge on reconnect,
//! and permanent stop after owner policy rejection.
use rca_native_agent::session::{
    maintain_authenticated_transport, ExecutionRequest, HeartbeatTiming, SessionError,
};
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::{Message, WebSocket};

mod common;
const DEVICE_ID: &str = "12345678-1234-1234-1234-123456789abc";

#[allow(clippy::result_large_err)] // Tungstenite owns the callback's HTTP response error type.
fn accept_with_nonce(listener: &TcpListener, nonce: &'static str) -> WebSocket<TcpStream> {
    let (mut http, _) = listener.accept().unwrap();
    let mut reader = BufReader::new(http.try_clone().unwrap());
    let mut first_line = String::new();
    reader.read_line(&mut first_line).unwrap();
    assert!(first_line.starts_with("POST /agent/session/challenge HTTP/1.1"));
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
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["device_id"],
        DEVICE_ID
    );
    let answer = json!({"device_id":DEVICE_ID,"nonce":nonce}).to_string();
    write!(http, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",answer.len(),answer).unwrap();
    drop(http);
    let (ws, _) = listener.accept().unwrap();
    ws.set_read_timeout(Some(Duration::from_secs(6))).unwrap();
    tungstenite::accept_hdr(ws, move |request: &Request, mut response: Response| {
        let offered = request
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            offered.starts_with(&format!("rc-v2, rcv2.{nonce}.")),
            "must use the new server nonce"
        );
        response
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, "rc-v2".parse().unwrap());
        Ok(response)
    })
    .unwrap()
}

#[test]
fn transient_transport_failure_redials_with_new_challenge_but_policy_stops() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let mut first = accept_with_nonce(&listener, "ABCDEFGHIJKLMNOPQRSTUVWX");
        first
            .send(Message::Close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "routine transport restart".into(),
            })))
            .unwrap();
        drop(first);
        let mut second = accept_with_nonce(&listener, "ZYXWVUTSRQPONMLKJIHGFEDC");
        second
            .send(Message::Close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "revoked".into(),
            })))
            .unwrap();
    });
    let (requests_tx, requests_rx) = mpsc::sync_channel::<ExecutionRequest>(2);
    let (_answers_tx, mut answers_rx) = tokio::sync::mpsc::channel(4);
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let result = maintain_authenticated_transport(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &stop,
        &requests_tx,
        &mut answers_rx,
        HeartbeatTiming::default(),
    );
    assert!(matches!(result, Err(SessionError::Policy)));
    assert!(
        requests_rx.try_recv().is_err(),
        "control closes must never become executable work"
    );
    server.join().unwrap();
}
