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
