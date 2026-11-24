//! Signed rc-v2 Unix loopback: one SQLite owner, OS-owned command,
//! no-replay operation receipts, and truthful Owner cleanup acknowledgements.
#![cfg(any(target_os = "linux", target_os = "macos"))]
mod common;

#[cfg(target_os = "macos")]
use rca_native_agent::darwin_managed::{DarwinManagedSessions as ManagedSessions, SessionState};
#[cfg(target_os = "linux")]
use rca_native_agent::linux_managed::{LinuxManagedSessions as ManagedSessions, SessionState};
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

struct StopOnPanic(Arc<AtomicBool>);
impl Drop for StopOnPanic {
    fn drop(&mut self) {
        if thread::panicking() {
            self.0.store(true, Ordering::Release);
        }
    }
}

fn accept_disposable(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                return stream;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < deadline,
                    "disposable Worker never connected"
                );
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => panic!("disposable Worker accept failed: {error}"),
        }
    }
}

fn managed() -> Arc<ManagedSessions> {
    #[cfg(target_os = "linux")]
    let helper = std::env::var("RCA_NATIVE_SUPERVISOR_BIN").expect("real Linux C helper required");
    #[cfg(target_os = "macos")]
    let helper = std::env::var("RCA_DARWIN_SUPERVISOR_BIN").expect("real Darwin C helper required");
    assert!(Path::new(&helper).is_file());
    Arc::new(
        ManagedSessions::new(
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
    let http = accept_disposable(&listener);
    challenge(http);
    let ws = accept_disposable(&listener);
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
#[ignore = "requires disposable Unix runner and platform C helper"]
fn signed_managed_process_start_input_read_receipt_and_revoke() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let _stop_on_panic = StopOnPanic(Arc::clone(&server_stop));
        let mut socket = signed_socket(listener);
        common::receive_device_info(&mut socket, true);
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
        server_stop.store(true, Ordering::Release);
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
#[ignore = "requires disposable Unix runner and platform C helper"]
fn owner_revoke_terminates_active_owned_descendants_before_confirmed_ack() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let _stop_on_panic = StopOnPanic(Arc::clone(&server_stop));
        let mut socket = signed_socket(listener);
        common::receive_device_info(&mut socket, true);
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
        .all(|entry| entry.state != SessionState::Running));
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
#[ignore = "requires disposable Unix runner and platform C helper"]
fn malformed_process_operation_stays_forbidden_with_policy_close_1008() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let _stop_on_panic = StopOnPanic(Arc::clone(&server_stop));
        let mut socket = signed_socket(listener);
        common::receive_device_info(&mut socket, true);
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

#[test]
#[ignore = "requires disposable Unix runner and platform C helper"]
fn four_concurrent_long_process_starts_fit_worker_deadline() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let _stop_on_panic = StopOnPanic(Arc::clone(&server_stop));
        let mut socket = signed_socket(listener);
        common::receive_device_info(&mut socket, true);
        socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(8)))
            .unwrap();
        let sent = Instant::now();
        for n in 1..=4 {
            let id = format!("00000000-0000-0000-0000-{n:012}");
            let frame = json!({"kind":"operation","request_id":id,"operation_id":format!("queue-{n}"),"tool":"start_process","arguments":{"command":"sleep 8","timeout_ms":1500}});
            socket
                .send(Message::Text(frame.to_string().into()))
                .unwrap();
        }
        let mut latencies = Vec::new();
        for _ in 0..4 {
            let response: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(response["result"]["status"], "running");
            latencies.push(sent.elapsed().as_millis());
        }
        eprintln!("four_start_latency_ms={latencies:?}");
        let revoke = reply(
            &mut socket,
            json!({"kind":"revoke_cleanup","request_id":"cccccccc-cccc-cccc-cccc-cccccccccccc"})
                .to_string(),
        );
        assert_eq!(revoke["status"], "confirmed");
        server_stop.store(true, Ordering::Release);
        assert!(
            latencies.iter().all(|&ms| ms < 5000),
            "Worker 5s deadline missed: {latencies:?}"
        );
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
}

#[test]
#[ignore = "requires disposable Unix runner and platform C helper"]
fn mixed_busy_worker_keeps_reads_status_and_owned_stop_available() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let files = root.path().join("files");
    std::fs::create_dir(&files).unwrap();
    for n in 0..16 {
        std::fs::write(files.join(format!("{n}.txt")), vec![b'x'; 2 * 1024 * 1024]).unwrap();
    }
    let sentinel = files.join("sentinel.txt");
    std::fs::write(&sentinel, "readable").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let registry = managed();
    let observed = Arc::clone(&registry);
    let server = thread::spawn(move || {
        let _stop_on_panic = StopOnPanic(Arc::clone(&server_stop));
        let mut socket = signed_socket(listener);
        common::receive_device_info(&mut socket, true);
        socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(7)))
            .unwrap();
        let initial = reply(
            &mut socket,
            operation(
                "owned-start",
                "start_process",
                json!({"command":"sleep 9","timeout_ms":0}),
            ),
        );
        assert_eq!(initial["result"]["status"], "running");
        let sid = initial["result"]["session_id"].as_str().unwrap().to_owned();
        let burst = Instant::now();
        for (n, kind, tool, args) in [
            (
                1,
                "operation",
                "start_process",
                json!({"command":"sleep 8","timeout_ms":1500}),
            ),
            (
                2,
                "operation",
                "start_process",
                json!({"command":"sleep 8","timeout_ms":1500}),
            ),
            (
                3,
                "read",
                "start_search",
                json!({"path":files,"pattern":"never-matches-914","search_type":"content"}),
            ),
            (4, "operation", "force_terminate", json!({"session_id":sid})),
        ] {
            let mut frame = json!({"kind":kind,"request_id":format!("00000000-0000-0000-0000-{n:012}"),"tool":tool,"arguments":args});
            if kind == "operation" {
                frame["operation_id"] = json!(format!("mixed-{n}"));
            }
            socket
                .send(Message::Text(frame.to_string().into()))
                .unwrap();
        }
        for n in 1..=4 {
            let response: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(
                response["request_id"],
                format!("00000000-0000-0000-0000-{n:012}")
            );
            assert!(
                burst.elapsed() < Duration::from_secs(5),
                "mixed reply {n} exceeded Worker budget"
            );
            if n == 3 {
                assert_eq!(response["status"], "completed");
            } else if n == 4 {
                assert!(matches!(
                    response["result"]["status"].as_str(),
                    Some("completed" | "unknown")
                ));
            } else {
                assert_eq!(response["result"]["status"], "running");
            }
        }
        assert_eq!(
            read(&mut socket, "read_file", json!({"path":sentinel}))["text"],
            "readable"
        );
        let status = reply(
            &mut socket,
            operation(
                "mixed-1",
                "get_operation_status",
                json!({"operation_id":"mixed-1"}),
            ),
        );
        assert_eq!(status["result"]["status"], "running");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = observed.get(&sid).unwrap();
            if snapshot.state != SessionState::Running {
                assert!(matches!(
                    snapshot.state,
                    SessionState::Completed | SessionState::Failed
                ));
                break;
            }
            assert!(Instant::now() < deadline, "owned stop did not complete");
            thread::sleep(Duration::from_millis(20));
        }
        let revoked = reply(
            &mut socket,
            json!({"kind":"revoke_cleanup","request_id":"cccccccc-cccc-cccc-cccc-cccccccccccc"})
                .to_string(),
        );
        assert_eq!(revoked["status"], "confirmed");
        server_stop.store(true, Ordering::Release);
    });
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        registry,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(result, Err(NativeFileError::Session(SessionError::Policy))),
        "{result:?}"
    );
}

#[test]
#[ignore = "requires disposable Unix runner and platform C helper"]
fn device_info_is_reported_once_per_authenticated_managed_connection() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let target = root.path().join("ordinary");
    std::fs::write(&target, "metadata-reconnect").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let server = thread::spawn(move || {
        let _stop = StopOnPanic(server_stop);
        let mut first = signed_socket(listener.try_clone().unwrap());
        let info = common::receive_device_info(&mut first, true);
        assert_eq!(
            read(&mut first, "read_file", json!({"path":target}))["text"],
            "metadata-reconnect"
        );
        first
            .close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "transport restart".into(),
            }))
            .unwrap();
        drop(first);
        let mut second = signed_socket(listener);
        assert_eq!(common::receive_device_info(&mut second, true), info);
        assert_eq!(
            read(&mut second, "read_file", json!({"path":target}))["text"],
            "metadata-reconnect"
        );
        second
            .close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "revoked".into(),
            }))
            .unwrap();
    });
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipt_dir,
        managed(),
        &stop,
        HeartbeatTiming::default(),
    );
    assert!(matches!(
        result,
        Err(NativeFileError::Session(SessionError::Policy))
    ));
    server.join().unwrap();
}
