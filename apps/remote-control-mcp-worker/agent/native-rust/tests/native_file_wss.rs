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
    signed_socket_ref(&listener)
}
fn accept_bounded(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                return stream;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "local WSS fixture accept timed out"
                );
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("{error}"),
        }
    }
}
#[allow(clippy::result_large_err)]
fn signed_socket_ref(listener: &TcpListener) -> WebSocket<TcpStream> {
    challenge(accept_bounded(listener));
    let ws = accept_bounded(listener);
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

#[test]
fn signed_file_session_creates_directory_and_deletes_regular_file_with_receipts() {
    let root = tempfile::tempdir().unwrap();
    let receipt_dir = root.path().join("receipts");
    let created = root.path().join("created");
    let forbidden = root.path().join("forbidden");
    let target = created.join("target.txt");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server_created = created.clone();
    let server_forbidden = forbidden.clone();
    let server_target = target.clone();
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        let mut command =
            |index: u32, tool: &str, operation_id: &str, arguments: Value, status: &str| {
                let request_id = format!("00000000-0000-0000-0000-{index:012}");
                socket
                    .send(Message::Text(
                        request(&request_id, tool, operation_id, arguments).into(),
                    ))
                    .unwrap();
                let reply: Value =
                    serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
                assert_eq!(reply["request_id"], request_id);
                assert_eq!(reply["kind"], "operation_result");
                assert_eq!(reply["result"]["status"], status);
                assert_eq!(reply["result"]["operation_id"], operation_id);
            };
        command(
            1,
            "create_directory",
            "mkdir-id",
            json!({"path":server_created}),
            "completed",
        );
        command(
            2,
            "create_directory",
            "mkdir-id",
            json!({"path":server_created}),
            "completed",
        );
        command(
            3,
            "create_directory",
            "mkdir-id",
            json!({"path":server_forbidden}),
            "conflict",
        );
        assert!(!server_forbidden.exists());
        command(
            4,
            "write_file",
            "write-id",
            json!({"path":server_target, "content":"first", "mode":"rewrite"}),
            "completed",
        );
        command(
            5,
            "delete_file",
            "unlink-id",
            json!({"path":server_target}),
            "completed",
        );
        assert!(!server_target.exists());
        std::fs::write(&server_target, "replacement").unwrap();
        command(
            6,
            "delete_file",
            "unlink-id",
            json!({"path":server_target}),
            "completed",
        );
        assert_eq!(
            std::fs::read_to_string(&server_target).unwrap(),
            "replacement"
        );
        command(
            7,
            "get_operation_status",
            "unlink-id",
            json!({"operation_id":"unlink-id"}),
            "completed",
        );
        socket
            .send(Message::Text(
                request(
                    "00000000-0000-0000-0000-000000000008",
                    "delete_file",
                    "invalid",
                    json!({"path":server_target,"recursive":true}),
                )
                .into(),
            ))
            .unwrap();
        match socket.read().unwrap() {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("expected invalid mutation policy close, got {other:?}"),
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
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "replacement");
    let receipts = ReceiptStore::open(&receipt_dir).unwrap();
    for (id, tool) in [
        ("mkdir-id", "create_directory"),
        ("unlink-id", "delete_file"),
    ] {
        let receipt = receipts.get(id).unwrap().unwrap();
        assert_eq!(receipt.state, "completed");
        assert_eq!(receipt.tool_name, tool);
    }
    assert!(receipts.get("invalid").unwrap().is_none());
}

#[test]
fn signed_file_session_moves_regular_file_with_idempotence_and_rejects_bad_moves() {
    let root = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    let source = root.path().join("source.txt");
    let destination = root.path().join("destination.txt");
    std::fs::write(&source, "preserve inode and contents").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server_source = source.clone();
    let server_dest = destination.clone();
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        for (id, from, to, expected) in [
            (
                "00000000-0000-0000-0000-000000000101",
                &server_source,
                &server_dest,
                "completed",
            ),
            (
                "00000000-0000-0000-0000-000000000102",
                &server_source,
                &server_dest,
                "completed",
            ),
            (
                "00000000-0000-0000-0000-000000000103",
                &server_source,
                &server_source,
                "conflict",
            ),
        ] {
            // The conflict changes intent to a different normalized destination
            // while preserving the same operation ID; raw same-path is a policy failure.
            let changed = if expected == "conflict" {
                json!({"source":from, "destination":server_dest.with_extension("other")})
            } else {
                json!({"source":from,"destination":to})
            };
            socket
                .send(Message::Text(
                    request(id, "move_file", "move-id", changed).into(),
                ))
                .unwrap();
            let reply: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(reply["kind"], "operation_result");
            assert_eq!(reply["request_id"], id);
            assert_eq!(reply["result"]["status"], expected);
        }
        socket
            .send(Message::Text(
                request(
                    "00000000-0000-0000-0000-000000000104",
                    "get_operation_status",
                    "move-id",
                    json!({"operation_id":"move-id"}),
                )
                .into(),
            ))
            .unwrap();
        let status: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(status["result"]["status"], "completed");
        assert_eq!(status["result"]["receipt"]["tool_name"], "move_file");
        socket
            .send(Message::Text(
                request(
                    "00000000-0000-0000-0000-000000000105",
                    "move_file",
                    "invalid-move",
                    json!({"source":server_dest,"destination":server_dest}),
                )
                .into(),
            ))
            .unwrap();
        match socket.read().unwrap() {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("expected rejected same-path move, got {other:?}"),
        }
    });
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipts,
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
    assert!(!source.exists());
    assert_eq!(
        std::fs::read_to_string(&destination).unwrap(),
        "preserve inode and contents"
    );
    let store = ReceiptStore::open(&receipts).unwrap();
    assert_eq!(store.get("move-id").unwrap().unwrap().state, "completed");
    assert!(store.get("invalid-move").unwrap().is_none());
}

#[test]
fn signed_file_session_edits_exact_text_with_receipt_and_policy_denial() {
    let root = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    let target = root.path().join("edit.txt");
    std::fs::write(&target, "red red").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let server_target = target.clone();
    let server = thread::spawn(move || {
        let mut socket = signed_socket(listener);
        let args = json!({"file_path":server_target,"old_string":"red",
            "new_string":"blue","expected_replacements":2});
        for (request_id, changed, expected) in [
            ("00000000-0000-0000-0000-000000000111", false, "completed"),
            ("00000000-0000-0000-0000-000000000112", false, "completed"),
            ("00000000-0000-0000-0000-000000000113", true, "conflict"),
        ] {
            let payload = if changed {
                json!({"file_path":server_target,"old_string":"red",
                    "new_string":"different","expected_replacements":2})
            } else {
                args.clone()
            };
            socket
                .send(Message::Text(
                    request(request_id, "edit_block", "edit-op", payload).into(),
                ))
                .unwrap();
            let reply: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(reply["request_id"], request_id);
            assert_eq!(reply["result"]["status"], expected);
        }
        socket
            .send(Message::Text(
                request(
                    "00000000-0000-0000-0000-000000000114",
                    "get_operation_status",
                    "edit-op",
                    json!({"operation_id":"edit-op"}),
                )
                .into(),
            ))
            .unwrap();
        let status: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(status["result"]["status"], "completed");
        assert_eq!(status["result"]["receipt"]["tool_name"], "edit_block");

        socket
            .send(Message::Text(
                request(
                    "00000000-0000-0000-0000-000000000115",
                    "edit_block",
                    "invalid-edit",
                    json!({"file_path":server_target,"old_string":"","new_string":"x"}),
                )
                .into(),
            ))
            .unwrap();
        match socket.read().unwrap() {
            Message::Close(Some(frame)) => assert_eq!(
                frame.code,
                tungstenite::protocol::frame::coding::CloseCode::Policy
            ),
            other => panic!("expected policy 1008 for invalid edit, got {other:?}"),
        }
    });
    let stop = Arc::new(AtomicBool::new(false));
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipts,
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
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "blue blue");
    let store = ReceiptStore::open(&receipts).unwrap();
    assert_eq!(store.get("edit-op").unwrap().unwrap().state, "completed");
    assert!(store.get("invalid-edit").unwrap().is_none());
}

#[test]
fn signed_file_search_pages_content_stop_and_bad_args_stay_connected() {
    let root = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    let search_root = root.path().join("files");
    std::fs::create_dir(&search_root).unwrap();
    for i in 0..25 {
        std::fs::write(search_root.join(format!("match-{i:02}.txt")), "needle\n").unwrap();
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let end = Arc::clone(&stop);
    let server =
        thread::spawn(move || {
            let mut socket = signed_socket(listener);
            let mut read =
                |n: usize, tool: &str, arguments: Value| -> Value {
                    let request_id = format!("00000000-0000-0000-0000-{n:012}");
                    socket.send(Message::Text(json!({
                "kind":"read","request_id":request_id,"tool":tool,"arguments":arguments
            }).to_string().into())).unwrap();
                    let reply: Value =
                        serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
                    assert_eq!(reply["kind"], "read_result");
                    assert_eq!(reply["request_id"], request_id);
                    reply
                };
            assert_eq!(
                read(
                    1,
                    "start_search",
                    json!({
                        "path":search_root,"pattern":"","search_type":"filename"
                    })
                )["status"],
                "failed"
            );
            let first = read(
                2,
                "start_search",
                json!({
                    "path":search_root,"pattern":"match","search_type":"filename"
                }),
            );
            let page: Value = serde_json::from_str(first["text"].as_str().unwrap()).unwrap();
            assert_eq!(page["results"].as_array().unwrap().len(), 20);
            assert_eq!(page["status"], "running");
            let id = page["session_id"].as_str().unwrap().to_owned();
            let next = read(3, "get_more_search_results", json!({"session_id":id}));
            let page: Value = serde_json::from_str(next["text"].as_str().unwrap()).unwrap();
            assert_eq!(page["results"].as_array().unwrap().len(), 5);
            assert_eq!(page["status"], "complete");
            assert_eq!(
                read(4, "get_more_search_results", json!({"session_id":id}))["status"],
                "failed"
            );
            let content = read(
                5,
                "start_search",
                json!({
                    "path":search_root,"pattern":"needle","search_type":"content"
                }),
            );
            let page: Value = serde_json::from_str(content["text"].as_str().unwrap()).unwrap();
            assert_eq!(page["results"].as_array().unwrap().len(), 20);
            assert_eq!(page["results"][0]["line"], 1);
            let id = page["session_id"].as_str().unwrap().to_owned();
            let stopped = read(6, "stop_search", json!({"session_id":id}));
            let page: Value = serde_json::from_str(stopped["text"].as_str().unwrap()).unwrap();
            assert_eq!(page["status"], "stopped");
            assert_eq!(
                read(7, "get_more_search_results", json!({"session_id":id}))["status"],
                "failed"
            );
            let valid = read(
                8,
                "read_file",
                json!({"path":search_root.join("match-00.txt")}),
            );
            assert_eq!(valid["status"], "completed");
            assert_eq!(valid["text"], "needle");
            end.store(true, Ordering::Release);
        });
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipts,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn search_cursors_do_not_survive_signed_transport_reconnect() {
    let root = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    let files = root.path().join("files");
    std::fs::create_dir(&files).unwrap();
    for i in 0..25 {
        std::fs::write(files.join(format!("match-{i:02}.txt")), "needle\n").unwrap();
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let end = Arc::clone(&stop);
    let server = thread::spawn(move || {
        struct StopOnExit(Arc<AtomicBool>);
        impl Drop for StopOnExit {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let _guard = StopOnExit(end);
        let read =
            |socket: &mut WebSocket<TcpStream>, n: usize, tool: &str, args: Value| -> Value {
                let request_id = format!("00000000-0000-0000-0000-{n:012}");
                socket
                    .send(Message::Text(
                        json!({
                            "kind":"read","request_id":request_id,"tool":tool,"arguments":args
                        })
                        .to_string()
                        .into(),
                    ))
                    .unwrap();
                let result: Value =
                    serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
                assert_eq!(result["request_id"], request_id);
                result
            };
        let args = json!({"path":files,"pattern":"match","search_type":"filename"});
        let mut first = signed_socket_ref(&listener);
        let mut ids = Vec::new();
        for n in 1..=4 {
            let reply = read(&mut first, n, "start_search", args.clone());
            assert_eq!(reply["status"], "completed");
            let page: Value = serde_json::from_str(reply["text"].as_str().unwrap()).unwrap();
            ids.push(page["session_id"].as_str().unwrap().to_owned());
        }
        first
            .send(Message::Close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "reconnect".into(),
            })))
            .unwrap();
        drop(first);
        let mut second = signed_socket_ref(&listener);
        let old = read(
            &mut second,
            5,
            "get_more_search_results",
            json!({"session_id":ids[0]}),
        );
        assert_eq!(
            old["status"], "failed",
            "old cursor belongs only to the first connection"
        );
        let stopped = read(&mut second, 6, "stop_search", json!({"session_id":ids[1]}));
        assert_eq!(stopped["status"], "failed");
        for n in 7..=10 {
            let reply = read(&mut second, n, "start_search", args.clone());
            assert_eq!(
                reply["status"], "completed",
                "all four slots must be available"
            );
        }
    });
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &receipts,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(result.is_ok(), "{result:?}");
}

fn assert_sqlite_busy(db: &std::path::Path) {
    let contender = std::process::Command::new("node")
            .args(["--input-type=module", "-e", r#"
                import {DatabaseSync} from 'node:sqlite';
                const db=new DatabaseSync(process.argv[1]);
                db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE');
                try { db.exec('BEGIN EXCLUSIVE'); }
                catch(e) { if (e.errcode===5 || /database is locked/i.test(String(e))) process.exit(0); throw e; }
                throw Error('exclusive lock escaped');
            "#]).arg(db).output().unwrap();
    assert!(
        contender.status.success(),
        "{}",
        String::from_utf8_lossy(&contender.stderr)
    );
}

#[test]
fn receipt_runtime_active_ledger_is_not_an_ordinary_file_and_remains_exclusive() {
    let root = tempfile::tempdir().unwrap();
    #[cfg(windows)]
    common::seal_windows_dir(root.path());
    let directory = root.path().join("receipts");
    drop(ReceiptStore::open(&directory).unwrap());
    let db = directory.join("operation-receipts.sqlite");
    let alias = root.path().join("alias");
    std::fs::hard_link(&db, &alias).unwrap();
    #[cfg(unix)]
    let symlink = {
        let path = root.path().join("symlink");
        std::os::unix::fs::symlink(&db, &path).unwrap();
        path
    };
    let normal = root.path().join("ordinary.txt");
    std::fs::write(&normal, "visible").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let end = Arc::clone(&stop);
    let ledger = directory.clone();
    let parent = root.path().to_owned();
    let server = thread::spawn(move || {
        struct Stop(Arc<AtomicBool>);
        impl Drop for Stop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let _stop = Stop(end);
        let mut socket = signed_socket(listener);
        let mut exchange = |body: String| -> Value {
            socket.send(Message::Text(body.into())).unwrap();
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap()
        };
        let read = |path: &std::path::Path| {
            json!({"kind":"read","request_id":"11111111-1111-1111-1111-111111111111","tool":"read_file","arguments":{"path":path}}).to_string()
        };
        assert_eq!(exchange(read(&db))["status"], "failed");
        assert_eq!(exchange(read(&alias))["status"], "failed");
        #[cfg(unix)]
        assert_eq!(exchange(read(&symlink))["status"], "failed");
        assert_eq!(exchange(read(&normal))["text"], "visible");
        let multiple = exchange(json!({"kind":"read","request_id":"55555555-5555-5555-5555-555555555555","tool":"read_multiple_files","arguments":{"paths":[alias,normal]}}).to_string());
        assert_eq!(multiple["status"], "completed");
        let text = multiple["text"].as_str().unwrap();
        assert!(text.contains("# file 1\nstatus: failed"));
        assert!(text.contains("# file 2\nstatus: ok\nvisible"));

        let search = exchange(json!({"kind":"read","request_id":"22222222-2222-2222-2222-222222222222","tool":"start_search","arguments":{"path":parent,"search_type":"content","pattern":"SQLite format 3"}}).to_string());
        assert_eq!(search["status"], "completed");
        let page: Value = serde_json::from_str(search["text"].as_str().unwrap()).unwrap();
        assert_eq!(page["results"].as_array().unwrap().len(), 0);
        assert_sqlite_busy(&db);
        for (n, tool, args) in [
            (
                1,
                "write_file",
                json!({"path":alias,"content":"must-not-write","mode":"append"}),
            ),
            (
                2,
                "edit_block",
                json!({"file_path":db,"old_string":"SQLite","new_string":"denied","expected_replacements":1}),
            ),
            (3, "delete_file", json!({"path":db})),
            (
                4,
                "move_file",
                json!({"source":alias,"destination":parent.join("moved")}),
            ),
            (
                5,
                "move_file",
                json!({"source":normal,"destination":ledger.join("new-file")}),
            ),
            (
                6,
                "create_directory",
                json!({"path":ledger.join("new-dir")}),
            ),
        ] {
            let result = exchange(request(
                "33333333-3333-3333-3333-333333333333",
                tool,
                &format!("deny-{n}"),
                args,
            ));
            assert!(
                matches!(
                    result["result"]["status"].as_str(),
                    Some("failed" | "unavailable")
                ),
                "{tool}: {result:?}"
            );
        }
        let result = exchange(request(
            "44444444-4444-4444-4444-444444444444",
            "write_file",
            "ordinary",
            json!({"path":normal,"content":"!","mode":"append"}),
        ));
        assert_eq!(result["result"]["status"], "completed");
        assert_sqlite_busy(&db);
    });
    let result = run_native_file_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &directory,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(result.is_ok(), "{result:?}");
    let store = ReceiptStore::open(&directory).unwrap();
    assert_eq!(store.get("ordinary").unwrap().unwrap().state, "completed");
}

#[test]
fn receipt_runtime_storage_faults_keep_signed_reads_and_deny_new_effects() {
    use rusqlite::Connection;
    for (mode, expected, content) in [
        ("corrupt", "unavailable", "original"),
        ("before", "unavailable", "original"),
        ("after", "unknown", "originalonce"),
    ] {
        let root = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        common::seal_windows_dir(root.path());
        let receipt_dir = root.path().join("receipts");
        drop(ReceiptStore::open(&receipt_dir).unwrap());
        let db = receipt_dir.join("operation-receipts.sqlite");
        if mode == "corrupt" {
            std::fs::write(&db, b"corrupt ledger -- preserve these bytes").unwrap();
        } else {
            let conn = Connection::open(&db).unwrap();
            let phase = if mode == "before" {
                "running"
            } else {
                "completed"
            };
            conn.execute_batch(&format!(
                "CREATE TRIGGER fail_fixture BEFORE UPDATE ON receipts
                 WHEN NEW.state='{phase}' BEGIN SELECT RAISE(ABORT,'fixture fault'); END;"
            ))
            .unwrap();
        }
        let original = std::fs::read(&db).unwrap();
        let target = root.path().join("target.txt");
        std::fs::write(&target, "original").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let end = Arc::clone(&stop);
        let file = target.clone();
        let directory = receipt_dir.clone();
        let server = thread::spawn(move || {
            struct Stop(Arc<AtomicBool>);
            impl Drop for Stop {
                fn drop(&mut self) {
                    self.0.store(true, Ordering::Release);
                }
            }
            let _stop = Stop(end);
            // Bound the red case: the old Agent exits before connecting.
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(4);
            let http = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "Agent never connected: {mode}"
                        );
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            http.set_nonblocking(false).unwrap();
            challenge(http);
            listener.set_nonblocking(false).unwrap();
            let (ws, _) = listener.accept().unwrap();
            ws.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            #[allow(clippy::result_large_err)]
            let mut socket = tungstenite::accept_hdr(ws, |_: &Request, mut response: Response| {
                response
                    .headers_mut()
                    .insert(SEC_WEBSOCKET_PROTOCOL, "rc-v2".parse().unwrap());
                Ok(response)
            })
            .unwrap();
            let mut exchange = |body: String| -> Value {
                socket.send(Message::Text(body.into())).unwrap();
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap()
            };
            let args = json!({"path":file,"content":"once","mode":"append"});
            let first = exchange(request(
                "11111111-1111-1111-1111-111111111111",
                "write_file",
                "fault-op",
                args.clone(),
            ));
            assert_eq!(first["result"]["status"], expected, "{mode}");
            let retry = exchange(request(
                "22222222-2222-2222-2222-222222222222",
                "write_file",
                "fault-op",
                args.clone(),
            ));
            assert_eq!(retry["result"]["status"], "unavailable");
            let fresh = exchange(request(
                "33333333-3333-3333-3333-333333333333",
                "write_file",
                "fresh-op",
                args,
            ));
            assert_eq!(fresh["result"]["status"], "unavailable");
            let status = exchange(request(
                "44444444-4444-4444-4444-444444444444",
                "get_operation_status",
                "fault-op",
                json!({"operation_id":"fault-op"}),
            ));
            assert_eq!(status["result"]["status"], "unavailable");
            let read = exchange(json!({"kind":"read","request_id":"55555555-5555-5555-5555-555555555555","tool":"read_file","arguments":{"path":file}}).to_string());
            assert_eq!(read["status"], "completed");
            assert_eq!(read["text"], content);
            assert!(
                ReceiptStore::open(&directory).is_err(),
                "a degraded Agent must still exclude another receipt owner"
            );
            if mode == "corrupt" {
                let read = exchange(json!({"kind":"read","request_id":"66666666-6666-6666-6666-666666666666","tool":"read_file","arguments":{"path":directory.join("operation-receipts.sqlite")}}).to_string());
                assert_eq!(read["status"], "failed");
            }
            // A corrupt database would itself cause open to fail; demand
            // SQLITE_BUSY from a genuinely separate SQLite process instead.
            assert_sqlite_busy(&directory.join("operation-receipts.sqlite"));
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
        assert!(result.is_ok(), "{mode}: {result:?}");
        assert_eq!(std::fs::read_to_string(target).unwrap(), content);
        if mode == "corrupt" {
            assert_eq!(std::fs::read(&db).unwrap(), original);
            let conn = Connection::open(&db).unwrap();
            let error = conn.execute_batch("BEGIN EXCLUSIVE").unwrap_err();
            assert!(
                matches!(error, rusqlite::Error::SqliteFailure(e, _) if e.code == rusqlite::ErrorCode::NotADatabase)
            );
        } else {
            let conn = Connection::open(&db).unwrap();
            let state: String = conn
                .query_row(
                    "SELECT state FROM receipts WHERE operation_id='fault-op'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                state,
                if mode == "before" {
                    "admitted"
                } else {
                    "running"
                }
            );
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM receipts WHERE operation_id='fresh-op'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 0);
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
#[test]
#[cfg_attr(
    unix,
    ignore = "requires disposable Unix runner and real platform C helper"
)]
fn receipt_runtime_storage_failure_preserves_only_owned_stop() {
    #[cfg(target_os = "macos")]
    use rca_native_agent::darwin_managed::{DarwinManagedSessions as Managed, SessionState};
    #[cfg(target_os = "linux")]
    use rca_native_agent::linux_managed::{LinuxManagedSessions as Managed, SessionState};
    use rca_native_agent::native_file::{run_native_managed_session, NativeFileError};
    #[cfg(windows)]
    use rca_native_agent::windows_managed::{SessionState, WindowsManagedSessions as Managed};
    let root = tempfile::tempdir().unwrap();
    #[cfg(windows)]
    common::seal_windows_dir(root.path());
    let directory = root.path().join("receipts");
    drop(ReceiptStore::open(&directory).unwrap());
    let db = directory.join("operation-receipts.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER fixture_storage_failure BEFORE UPDATE ON receipts
        WHEN NEW.state='running' AND NEW.tool_name='write_file'
        BEGIN SELECT RAISE(ABORT,'fixture storage fault'); END;",
    )
    .unwrap();
    drop(conn);
    #[cfg(target_os = "linux")]
    let helper = std::env::var("RCA_NATIVE_SUPERVISOR_BIN").unwrap();
    #[cfg(target_os = "macos")]
    let helper = std::env::var("RCA_DARWIN_SUPERVISOR_BIN").unwrap();
    #[cfg(unix)]
    let managed = Arc::new(
        Managed::new(
            std::path::Path::new(&helper),
            std::path::Path::new("/bin/sh"),
            Duration::from_secs(30),
        )
        .unwrap(),
    );
    #[cfg(windows)]
    let managed = Arc::new(Managed::new(Duration::from_secs(30)).unwrap());
    #[cfg(unix)]
    let command = "sleep 25";
    #[cfg(windows)]
    let command = "Start-Sleep -Seconds 25";
    let observed = Arc::clone(&managed);
    let target = root.path().join("ordinary");
    std::fs::write(&target, "before").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let end = Arc::clone(&stop);
    let server = thread::spawn(move || {
        struct Stop(Arc<AtomicBool>);
        impl Drop for Stop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let _stop = Stop(end);
        let mut socket = signed_socket(listener);
        let mut call = |id: &str, tool: &str, args: Value| -> Value {
            socket
                .send(Message::Text(
                    request("11111111-1111-1111-1111-111111111111", tool, id, args).into(),
                ))
                .unwrap();
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap()
        };
        let start = call(
            "owned-start",
            "start_process",
            json!({"command":command,"timeout_ms":0}),
        );
        assert_eq!(start["result"]["status"], "running");
        let sid = start["result"]["session_id"].as_str().unwrap().to_owned();
        let failure = call(
            "fault-write",
            "write_file",
            json!({"path":target,"mode":"append","content":"never"}),
        );
        assert_eq!(failure["result"]["status"], "unavailable");
        assert_eq!(
            call(
                "new-start",
                "start_process",
                json!({"command":command,"timeout_ms":0})
            )["result"]["status"],
            "unavailable"
        );
        assert_eq!(
            call(
                "input",
                "interact_with_process",
                json!({"session_id":sid,"input":"ignored"})
            )["result"]["status"],
            "unavailable"
        );
        assert_eq!(
            call(
                "unknown-stop",
                "force_terminate",
                json!({"session_id":"00000000-0000-4000-8000-000000000000"})
            )["result"]["status"],
            "unavailable"
        );
        let terminated = call("owned-stop", "force_terminate", json!({"session_id":sid}));
        assert_eq!(terminated["result"]["status"], "unknown");
        assert!(terminated["result"]["receipt"].is_null());
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            let snapshot = observed.get(&sid).unwrap();
            if snapshot.state != SessionState::Running {
                assert!(matches!(
                    snapshot.state,
                    SessionState::Completed | SessionState::Failed
                ));
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "owned process was not stopped"
            );
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(std::fs::read_to_string(target).unwrap(), "before");
        assert_eq!(
            call(
                "owned-stop",
                "get_operation_status",
                json!({"operation_id":"owned-stop"})
            )["result"]["status"],
            "unavailable"
        );
        socket.send(Message::Text(json!({"kind":"read","request_id":"22222222-2222-2222-2222-222222222222","tool":"list_sessions","arguments":{}}).to_string().into())).unwrap();
        let sessions: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(sessions["status"], "completed");
        assert_sqlite_busy(&db);
        socket.send(Message::Text(json!({"kind":"revoke_cleanup","request_id":"33333333-3333-3333-3333-333333333333"}).to_string().into())).unwrap();
        let revoked: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(revoked["status"], "confirmed");
    });
    let result = run_native_managed_session(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &directory,
        managed,
        &stop,
        HeartbeatTiming::default(),
    );
    server.join().unwrap();
    assert!(
        matches!(result, Err(NativeFileError::Session(SessionError::Policy))),
        "{result:?}"
    );
    let reopened = ReceiptStore::open(&directory).unwrap();
    assert_eq!(
        reopened.get("owned-start").unwrap().unwrap().state,
        "unknown"
    );
    assert!(reopened.get("new-start").unwrap().is_none());
    assert!(reopened.get("input").unwrap().is_none());
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
#[ignore = "requires disposable Unix runner and real platform C helper"]
fn receipt_runtime_degraded_connection_does_not_authorize_upgrade() {
    #[cfg(target_os = "macos")]
    use rca_native_agent::darwin_managed::DarwinManagedSessions as Managed;
    #[cfg(target_os = "linux")]
    use rca_native_agent::linux_managed::LinuxManagedSessions as Managed;
    use rca_native_agent::native_file::{
        run_native_managed_session_with_upgrade, UpgradeRuntimeOptions,
    };
    use std::os::unix::net::UnixStream;
    let root = tempfile::Builder::new()
        .prefix("rca-fixture-")
        .tempdir_in("/tmp")
        .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let directory = root.path().join("receipts");
    drop(ReceiptStore::open(&directory).unwrap());
    std::fs::write(
        directory.join("operation-receipts.sqlite"),
        b"corrupt fixture",
    )
    .unwrap();
    let target = root.path().join("ordinary.txt");
    std::fs::write(&target, "readable").unwrap();
    #[cfg(target_os = "linux")]
    let helper = std::env::var("RCA_NATIVE_SUPERVISOR_BIN").unwrap();
    #[cfg(target_os = "macos")]
    let helper = std::env::var("RCA_DARWIN_SUPERVISOR_BIN").unwrap();
    let managed = Arc::new(
        Managed::new(
            std::path::Path::new(&helper),
            std::path::Path::new("/bin/sh"),
            Duration::from_secs(20),
        )
        .unwrap(),
    );
    let connected = Arc::new(AtomicBool::new(false));
    let activation = Arc::clone(&connected);
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);
    let stop = Arc::new(AtomicBool::new(false));
    let end = Arc::clone(&stop);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let ipc = root.path().join("upgrade.sock");
    let server = thread::spawn(move || {
        struct Stop(Arc<AtomicBool>);
        impl Drop for Stop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let _stop = Stop(end);
        let mut socket = signed_socket(listener);
        socket.send(Message::Text(json!({"kind":"read","request_id":"11111111-1111-1111-1111-111111111111","tool":"read_file","arguments":{"path":target}}).to_string().into())).unwrap();
        let read: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(read["text"], "readable");
        assert!(!activation.load(Ordering::Acquire));
        assert_eq!(captured.lock().unwrap().as_slice(), ["receipt_corrupt"]);
        for command in ["freeze\n", "verify-frozen\n"] {
            let mut client = UnixStream::connect(&ipc).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            client.write_all(command.as_bytes()).unwrap();
            let mut reply = String::new();
            BufReader::new(client).read_line(&mut reply).unwrap();
            assert_eq!(reply, "busy\n");
        }
    });
    let result = run_native_managed_session_with_upgrade(
        &endpoint,
        &common::test_pem(),
        DEVICE_ID,
        &directory,
        managed,
        &stop,
        UpgradeRuntimeOptions {
            key_path: &root.path().join("fixture-ipc"),
            on_connected: Some(Arc::new(move || {
                connected.store(true, Ordering::Release);
            })),
            on_disconnected: None,
            on_diagnostic: Some(Arc::new(move |event| events.lock().unwrap().push(event))),
        },
    );
    assert!(result.is_ok(), "{result:?}");
    server.join().unwrap();
}
