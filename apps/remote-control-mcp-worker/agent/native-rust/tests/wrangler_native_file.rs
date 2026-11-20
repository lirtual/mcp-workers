//! Opt-in real local Wrangler + SQLite Durable Object + Owner MCP + Rust file session.
//! The isolated fixture must be a newly paired, disposable identity under /tmp.
//! It never accepts a production endpoint or a user/device file.
use rca_native_agent::native_file::{run_native_file_session, NativeFileError};
use rca_native_agent::session::{HeartbeatTiming, SessionError};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[test]
#[ignore = "requires isolated local Wrangler/SQLite DO and a disposable, approved test identity"]
fn actual_owner_mcp_write_read_receipt_and_revoke_roundtrip() {
    let root = std::env::var("RCA_LOCAL_NATIVE_FILE_ROOT").expect("explicit test root required");
    let root = Path::new(&root);
    assert!(
        root.parent() == Some(Path::new("/tmp"))
            && root
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("rca-gate1-file-"))
    );
    let meta = std::fs::symlink_metadata(root).unwrap();
    assert!(meta.is_dir() && !meta.file_type().is_symlink());
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let uid = unsafe { libc::geteuid() };
        assert_eq!(meta.uid(), uid);
        assert_eq!(meta.permissions().mode() & 0o077, 0);
        for name in ["native-test-key.pem", "device-id", "owner-token"] {
            let entry = std::fs::symlink_metadata(root.join(name)).unwrap();
            assert!(entry.is_file() && !entry.file_type().is_symlink() && entry.len() <= 8192);
            assert_eq!(entry.uid(), uid);
            assert_eq!(
                entry.permissions().mode() & 0o077,
                0,
                "{name} must be private"
            );
        }
    }

    let pem = std::fs::read_to_string(root.join("native-test-key.pem")).unwrap();
    let device_id = std::fs::read_to_string(root.join("device-id")).unwrap();
    let owner_token = std::fs::read_to_string(root.join("owner-token")).unwrap();
    let device_id = device_id.trim();
    let owner_token = owner_token.trim();
    assert_eq!(device_id.len(), 36);
    assert!(owner_token.len() >= 32);
    let target = root.join("native-created.txt");
    assert!(!target.exists());
    let receipts = root.join("receipts");
    let stop = Arc::new(AtomicBool::new(false));
    let agent_stop = Arc::clone(&stop);
    let agent_pem = pem.clone();
    let agent_id = device_id.to_owned();
    let agent = thread::spawn(move || {
        run_native_file_session(
            "http://127.0.0.1:8777/",
            &agent_pem,
            &agent_id,
            &receipts,
            &agent_stop,
            HeartbeatTiming::default(),
        )
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let rpc = |name: &str, args: Value, token: &str| -> Result<(u16, Value), String> {
        let response = client
            .post("http://127.0.0.1:8777/mcp")
            .header("authorization", format!("Bearer {token}"))
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                "params":{"name":name,"arguments":args}}))
            .send()
            .map_err(|error| format!("{name} request failed: {error}"))?;
        let status = response.status().as_u16();
        let body: Value = response
            .json()
            .map_err(|_| format!("{name} invalid JSON"))?;
        Ok((status, body))
    };
    let tool = |name: &str, args: Value| -> Result<Value, String> {
        let (status, body) = rpc(name, args, owner_token)?;
        if status != 200 {
            return Err(format!("{name} HTTP {status}"));
        }
        if body["result"]["isError"] == Value::Bool(true) {
            return Err(format!("{name} Owner rejected request"));
        }
        let text = body["result"]["content"][0]["text"]
            .as_str()
            .ok_or_else(|| format!("{name} missing result text"))?;
        if name == "read_file" {
            Ok(Value::String(text.to_string()))
        } else {
            serde_json::from_str(text).map_err(|_| format!("{name} non-JSON receipt"))
        }
    };

    let result = (|| -> Result<(), String> {
        let id = "rca914-real-local-write-001";
        let arguments = json!({"device_id":device_id, "operation_id":id,
            "path":target, "content":"Rust real Owner file roundtrip", "mode":"rewrite"});
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            let reply = tool("write_file", arguments.clone())?;
            if reply["status"] == "completed" {
                break;
            }
            if reply["status"] != "offline" && reply["status"] != "busy" {
                return Err(format!("write_file unexpected result: {reply}"));
            }
            if Instant::now() >= deadline {
                return Err("Rust Agent did not become ready".into());
            }
            thread::sleep(Duration::from_millis(300));
        }
        let actual = std::fs::read_to_string(&target).map_err(|_| "write had no file effect")?;
        if actual != "Rust real Owner file roundtrip" {
            return Err(format!("native written content mismatch {actual:?}"));
        }
        let duplicate = tool("write_file", arguments.clone())?;
        if duplicate["status"] != "completed" {
            return Err(format!(
                "duplicate operation was not idempotent: {duplicate}"
            ));
        }
        let conflict = tool(
            "write_file",
            json!({"device_id":device_id,"operation_id":id,
            "path":target,"content":"CONFLICT-MUST-NOT-WRITE","mode":"rewrite"}),
        )?;
        if conflict["status"] != "conflict" {
            return Err(format!("changed payload did not conflict: {conflict}"));
        }
        let status = tool(
            "get_operation_status",
            json!({
                "device_id":device_id,"operation_id":id
            }),
        )?;
        if status["status"] != "completed" || status["receipt"]["state"] != "completed" {
            return Err(format!("receipt did not survive Owner roundtrip: {status}"));
        }
        let read = tool("read_file", json!({"device_id":device_id,"path":target}))?;
        if read.as_str() != Some("Rust real Owner file roundtrip") {
            return Err(format!("read_file returned {read:?}"));
        }
        if std::fs::read_to_string(&target).unwrap() != "Rust real Owner file roundtrip" {
            return Err("conflicting retry had a file effect".into());
        }
        println!("REAL_WORKER_NATIVE_FILE_WRITE_READ_IDEMPOTENCY_RECEIPT_PASSED");

        let created = root.join("owner-created-dir");
        let create_args = json!({"device_id":device_id,"operation_id":"owner-mkdir-001",
            "path":created});
        let create = tool("create_directory", create_args.clone())?;
        if create["status"] != "completed" || !created.is_dir() {
            return Err(format!("Owner directory create failed: {create}"));
        }
        if tool("create_directory", create_args)?["status"] != "completed" {
            return Err("Owner directory create was not idempotent".into());
        }
        let disposable = created.join("only-this-file.txt");
        std::fs::write(&disposable, "delete me").map_err(|_| "test file setup failed")?;
        let delete_args = json!({"device_id":device_id,"operation_id":"owner-delete-001",
            "path":disposable});
        let deleted = tool("delete_file", delete_args.clone())?;
        if deleted["status"] != "completed" || disposable.exists() {
            return Err(format!(
                "Owner delete_file did not remove regular file: {deleted}"
            ));
        }
        std::fs::write(&disposable, "replacement").map_err(|_| "test file recreation failed")?;
        if tool("delete_file", delete_args)?["status"] != "completed"
            || std::fs::read_to_string(&disposable).unwrap() != "replacement"
        {
            return Err("Owner repeated delete_file was not no-replay".into());
        }
        let directory_delete = tool(
            "delete_file",
            json!({"device_id":device_id,
            "operation_id":"owner-dir-reject-001","path":created}),
        )?;
        if directory_delete["status"] != "failed" || !created.is_dir() {
            return Err(format!(
                "Owner delete_file accepted a directory: {directory_delete}"
            ));
        }
        println!("REAL_WORKER_NATIVE_DIRECTORY_CREATE_DELETE_NO_REPLAY_PASSED");

        let revoke = tool("revoke_device", json!({"device_id":device_id}))?;
        if revoke["status"] != "revoked" {
            return Err(format!("revoke did not settle: {revoke}"));
        }
        let challenge = client
            .post("http://127.0.0.1:8777/agent/session/challenge")
            .json(&json!({"device_id":device_id}))
            .send()
            .map_err(|_| "revoked challenge failed")?;
        if ![401, 403, 404].contains(&challenge.status().as_u16()) {
            return Err("revoked identity was not rejected".into());
        }
        println!("REAL_WORKER_NATIVE_FILE_REVOKE_REJECT_PASSED");
        Ok(())
    })();

    stop.store(true, Ordering::Release);
    let agent_result = agent.join().expect("native file executor must not panic");
    assert!(
        matches!(
            agent_result,
            Ok(())
                | Err(NativeFileError::Session(SessionError::Policy))
                | Err(NativeFileError::Session(SessionError::Ws(_)))
        ),
        "{agent_result:?}"
    );
    assert!(result.is_ok(), "{result:?}");
}
