//! Full unshipped Standard Linux process seam against a disposable loopback Worker.
//! No installed identity, production endpoint or live Shell operation is used.
#[cfg(target_os = "linux")]
mod common;

#[cfg(target_os = "linux")]
mod linux {
    use crate::common;
    use rca_native_agent::identity::signed_session_proof;
    use rca_native_agent::receipts::ReceiptStore;
    use serde_json::{json, Value};
    use std::fs;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::path::Path;
    use std::process::{Child, Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};
    use tungstenite::handshake::server::{Request, Response};
    use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
    use tungstenite::protocol::frame::coding::CloseCode;
    use tungstenite::protocol::{CloseFrame, Message, WebSocket};

    const ID: &str = "123e4567-e89b-42d3-a456-426614174001";
    const NONCE: &str = "ABCDEFGHIJKLMNOPQRSTUVWX";

    struct StopChild(Child);
    impl Drop for StopChild {
        fn drop(&mut self) {
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }

    fn private_file(path: &Path, text: &str) {
        fs::write(path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn accept(listener: &TcpListener) -> TcpStream {
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
                        "candidate never reached disposable Worker"
                    );
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("disposable Worker accept: {error}"),
            }
        }
    }

    fn challenge(mut stream: TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("POST /agent/session/challenge HTTP/1.1"));
        let mut length = 0;
        loop {
            line.clear();
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
            ID
        );
        let response = json!({"device_id":ID,"nonce":NONCE}).to_string();
        write!(stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response.len(), response
        ).unwrap();
    }

    #[allow(clippy::result_large_err)] // tungstenite's fixed handshake callback signature
    fn connected(listener: TcpListener) -> WebSocket<TcpStream> {
        challenge(accept(&listener));
        let stream = accept(&listener);
        let signature = signed_session_proof(&common::test_pem(), ID, NONCE).unwrap();
        let expected = format!("rc-v2, rcv2.{NONCE}.{}", signature.proof);
        tungstenite::accept_hdr(stream, move |request: &Request, mut response: Response| {
            assert_eq!(
                request
                    .headers()
                    .get(SEC_WEBSOCKET_PROTOCOL)
                    .unwrap()
                    .to_str()
                    .unwrap(),
                expected
            );
            response
                .headers_mut()
                .insert(SEC_WEBSOCKET_PROTOCOL, "rc-v2".parse().unwrap());
            Ok(response)
        })
        .unwrap()
    }

    fn operation(request_id: &str, content: &str, target: &Path) -> String {
        json!({
            "kind":"operation","request_id":request_id,
            "operation_id":"standard-cli-once",
            "tool":"write_file",
            "arguments":{"path":target,"content":content,"mode":"rewrite"}
        })
        .to_string()
    }

    fn upgrade(socket: &Path, action: &str) -> String {
        let mut stream = UnixStream::connect(socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream.write_all(format!("{action}\n").as_bytes()).unwrap();
        let mut result = String::new();
        stream.read_to_string(&mut result).unwrap();
        result
    }

    fn reply(socket: &mut WebSocket<TcpStream>, frame: String) -> Value {
        socket.send(Message::Text(frame.into())).unwrap();
        serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap()
    }

    #[test]
    fn existing_identity_signed_wss_is_one_sqlite_owner_with_policy_shutdown() {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let key = root.path().join("v2-identity.pem");
        private_file(&key, &common::test_pem());
        private_file(
            &root.path().join("v2-identity.pem.device-id"),
            &format!("{ID}\n"),
        );
        let bin = root.path().join("rca-standard-linux-candidate");
        fs::copy(env!("CARGO_BIN_EXE_rca-standard-linux-candidate"), &bin).unwrap();
        // No Shell operation is sent; the disposable sibling is validated but
        // never executed. A physical C helper remains its own Gate 1 test.
        let helper = root.path().join("session-supervisor");
        fs::copy(&bin, &helper).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        let target = root.path().join("written.txt");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server_target = target.clone();
        let upgrade_socket = root.path().join("upgrade.sock");
        let server = thread::spawn(move || {
            let mut socket = connected(listener);
            assert_eq!(upgrade(&upgrade_socket, "freeze"), "ready\n");
            assert_eq!(upgrade(&upgrade_socket, "verify-frozen"), "ready\n");
            let denied = reply(
                &mut socket,
                operation(
                    "00000000-0000-0000-0000-000000000000",
                    "denied",
                    &server_target,
                ),
            );
            assert_eq!(denied["result"]["error"]["code"], "unavailable");
            assert!(
                !server_target.exists(),
                "frozen admission must have no file effect"
            );
            assert_eq!(upgrade(&upgrade_socket, "release"), "released\n");
            assert_eq!(upgrade(&upgrade_socket, "verify-frozen"), "busy\n");
            let first = reply(
                &mut socket,
                operation(
                    "11111111-1111-1111-1111-111111111111",
                    "first",
                    &server_target,
                ),
            );
            assert_eq!(first["kind"], "operation_result");
            assert_eq!(first["result"]["status"], "completed");
            fs::write(&server_target, "outside").unwrap();
            let repeated = reply(
                &mut socket,
                operation(
                    "22222222-2222-2222-2222-222222222222",
                    "first",
                    &server_target,
                ),
            );
            assert_eq!(repeated["result"]["status"], "completed");
            assert_eq!(fs::read_to_string(&server_target).unwrap(), "outside");
            let conflicting = reply(
                &mut socket,
                operation(
                    "33333333-3333-3333-3333-333333333333",
                    "other",
                    &server_target,
                ),
            );
            assert_eq!(conflicting["result"]["status"], "conflict");
            let status = reply(
                &mut socket,
                json!({
                    "kind":"operation","request_id":"44444444-4444-4444-4444-444444444444",
                    "operation_id":"standard-cli-once","tool":"get_operation_status",
                    "arguments":{"operation_id":"standard-cli-once"}
                })
                .to_string(),
            );
            assert_eq!(status["result"]["receipt"]["state"], "completed");
            socket
                .close(Some(CloseFrame {
                    code: CloseCode::Policy,
                    reason: "owner revoked".into(),
                }))
                .unwrap();
        });

        let mut child = StopChild(
            Command::new(&bin)
                .env_clear()
                .env("HOME", root.path())
                .env("REMOTE_CONTROL_AGENT_KEY_PATH", &key)
                .env("REMOTE_CONTROL_AGENT_ENDPOINT", &endpoint)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        server.join().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let exit = loop {
            if let Some(exit) = child.0.try_wait().unwrap() {
                break exit;
            }
            assert!(
                Instant::now() < deadline,
                "policy stop did not exit candidate"
            );
            thread::sleep(Duration::from_millis(20));
        };
        assert!(
            exit.success(),
            "signed policy close should not restart service"
        );
        let receipts = root
            .path()
            .join(".local/state/mcp-workers/remote-control-agent");
        let receipt = ReceiptStore::open(&receipts)
            .unwrap()
            .get("standard-cli-once")
            .unwrap()
            .unwrap();
        assert_eq!(receipt.state, "completed");
        assert_eq!(receipt.tool_name, "write_file");
        assert_eq!(fs::read_to_string(target).unwrap(), "outside");
    }

    #[test]
    #[ignore = "requires disposable Linux runner and actual built C supervisor"]
    fn actual_c_supervisor_cleanup_is_confirmed_before_standard_cli_exits() {
        let helper_path = std::env::var("RCA_NATIVE_SUPERVISOR_BIN")
            .expect("build the existing C helper before physical acceptance");
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let key = root.path().join("v2-identity.pem");
        private_file(&key, &common::test_pem());
        private_file(
            &root.path().join("v2-identity.pem.device-id"),
            &format!("{ID}\n"),
        );
        let bin = root.path().join("rca-standard-linux-candidate");
        fs::copy(env!("CARGO_BIN_EXE_rca-standard-linux-candidate"), &bin).unwrap();
        let helper = root.path().join("session-supervisor");
        fs::copy(helper_path, &helper).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let upgrade_socket = root.path().join("upgrade.sock");
        let server = thread::spawn(move || {
            let mut socket = connected(listener);
            let started = reply(
                &mut socket,
                json!({
                    "kind":"operation",
                    "request_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "operation_id":"standard-owned-process",
                    "tool":"start_process",
                    "arguments":{"command":"sleep 30","timeout_ms":0}
                })
                .to_string(),
            );
            assert_eq!(started["result"]["status"], "running");
            assert_eq!(upgrade(&upgrade_socket, "freeze"), "busy\n");
            assert_eq!(upgrade(&upgrade_socket, "verify-frozen"), "busy\n");
            let ack = reply(
                &mut socket,
                json!({
                    "kind":"revoke_cleanup",
                    "request_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
                })
                .to_string(),
            );
            assert_eq!(ack["status"], "confirmed");
        });

        let mut child = StopChild(
            Command::new(&bin)
                .env_clear()
                .env("HOME", root.path())
                .env("REMOTE_CONTROL_AGENT_KEY_PATH", &key)
                .env("REMOTE_CONTROL_AGENT_ENDPOINT", &endpoint)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        server.join().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let exit = loop {
            if let Some(exit) = child.0.try_wait().unwrap() {
                break exit;
            }
            assert!(
                Instant::now() < deadline,
                "confirmed cleanup failed to exit candidate"
            );
            thread::sleep(Duration::from_millis(20));
        };
        assert!(
            exit.success(),
            "policy stop with confirmed owned cleanup must exit zero"
        );
        let receipts = root
            .path()
            .join(".local/state/mcp-workers/remote-control-agent");
        let receipt = ReceiptStore::open(&receipts)
            .unwrap()
            .get("standard-owned-process")
            .unwrap()
            .unwrap();
        assert_eq!(receipt.state, "completed");
        assert_eq!(receipt.tool_name, "start_process");
    }
}
