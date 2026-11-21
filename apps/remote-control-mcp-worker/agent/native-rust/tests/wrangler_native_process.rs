//! Opt-in local Wrangler + SQLite Durable Object + temporary Owner Grant
//! against the actual Rust C-supervised process WSS executor. Never production.
#![cfg(target_os = "linux")]

use rca_native_agent::linux_managed::{LinuxManagedSessions, SessionState};
use rca_native_agent::linux_supervisor::CleanupState;
use rca_native_agent::native_file::{run_native_managed_session, NativeFileError};
use rca_native_agent::session::{HeartbeatTiming, SessionError};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[test]
#[ignore = "requires isolated local Wrangler/SQLite DO, disposable signed Owner Grant and C helper"]
fn owner_run_input_output_receipt_and_revoke_use_native_process() {
    let root = std::env::var("RCA_LOCAL_NATIVE_PROCESS_ROOT")
        .expect("explicit throwaway process test root required");
    let root = Path::new(&root);
    assert!(
        root.parent() == Some(Path::new("/tmp"))
            && root
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("rca-gate1-process-"))
    );
    let meta = std::fs::symlink_metadata(root).unwrap();
    assert!(meta.is_dir() && !meta.file_type().is_symlink());
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    assert_eq!(meta.uid(), unsafe { libc::geteuid() });
    assert_eq!(meta.permissions().mode() & 0o077, 0);
    for name in ["native-test-key.pem", "device-id", "owner-token"] {
        let info = std::fs::symlink_metadata(root.join(name)).unwrap();
        assert!(info.is_file() && !info.file_type().is_symlink() && info.len() <= 8192);
        assert_eq!(info.uid(), unsafe { libc::geteuid() });
        assert_eq!(info.permissions().mode() & 0o077, 0);
    }
    let helper = std::env::var("RCA_NATIVE_SUPERVISOR_BIN").unwrap();
    assert!(Path::new(&helper).is_absolute() && Path::new(&helper).is_file());
    let pem = std::fs::read_to_string(root.join("native-test-key.pem")).unwrap();
    let device_id = std::fs::read_to_string(root.join("device-id")).unwrap();
    let owner_token = std::fs::read_to_string(root.join("owner-token")).unwrap();
    let device_id = device_id.trim();
    let owner_token = owner_token.trim();
    let registry = Arc::new(
        LinuxManagedSessions::new(
            Path::new(&helper),
            Path::new("/bin/sh"),
            Duration::from_secs(15),
        )
        .unwrap(),
    );
    let receipts = root.join("receipts");
    let stop = Arc::new(AtomicBool::new(false));
    let agent_pem = pem.clone();
    let agent_id = device_id.to_owned();
    let owned = Arc::clone(&registry);
    let agent_stop = Arc::clone(&stop);
    let agent = thread::spawn(move || {
        run_native_managed_session(
            "http://127.0.0.1:8777/",
            &agent_pem,
            &agent_id,
            &receipts,
            owned,
            &agent_stop,
            HeartbeatTiming::default(),
        )
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let tool = |name: &str, args: Value| -> Result<Value, String> {
        let response = client
            .post("http://127.0.0.1:8777/mcp")
            .bearer_auth(owner_token)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                "params":{"name":name,"arguments":args}}))
            .send()
            .map_err(|_| "Owner MCP request failed")?;
        if response.status() != 200 {
            return Err(format!("{name} returned HTTP {}", response.status()));
        }
        let reply: Value = response.json().map_err(|_| "invalid Owner MCP JSON")?;
        if reply["result"]["isError"] == true {
            return Err(format!("{name} Owner MCP isError"));
        }
        let text = reply["result"]["content"][0]["text"]
            .as_str()
            .ok_or("Owner MCP text missing")?;
        serde_json::from_str(text).map_err(|_| format!("{name} result was not JSON"))
    };

    let result = (|| -> Result<(), String> {
        let id = "p-real-start-914";
        let args = json!({"device_id":device_id,"operation_id":id,
            "command":"IFS= read -r v; printf '%s' \"$v\"","timeout_ms":0});
        let ready_by = Instant::now() + Duration::from_secs(25);
        let first = loop {
            let reply = tool("run_command", args.clone())?;
            if reply["status"] == "running" || reply["status"] == "completed" {
                break reply;
            }
            if reply["status"] != "offline" && reply["status"] != "busy" {
                return Err(format!("unexpected process admission: {}", reply["status"]));
            }
            if Instant::now() >= ready_by {
                return Err("native process Agent offline".into());
            }
            thread::sleep(Duration::from_millis(250));
        };
        let sid = first["session_id"]
            .as_str()
            .ok_or("process admission omitted session_id")?
            .to_owned();
        if first["status"] != "running" {
            return Err("command exited before stdin".into());
        }
        let input = json!({"device_id":device_id,"operation_id":"p-real-stdin-914",
            "session_id":sid,"input":"中😀\n"});
        if tool("send_input", input.clone())?["status"] != "completed" {
            return Err("Owner stdin was not completed".into());
        }
        if tool("send_input", input)?["status"] != "completed" {
            return Err("duplicate Owner input lost receipt".into());
        }
        if tool(
            "send_input",
            json!({"device_id":device_id,
            "operation_id":"p-real-stdin-914","session_id":sid,"input":"other\n"}),
        )?["status"]
            != "conflict"
        {
            return Err("changed Owner input was not conflicted".into());
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let page = tool(
                "read_session_output",
                json!({"device_id":device_id,
                "session_id":sid,"offset":0,"length":256}),
            )?;
            if page["output"] == "中😀" && page["state"] == "completed" {
                if page["started_at"].as_str().is_none()
                    || page["last_observed_at"].as_str().is_none()
                {
                    return Err("Node session timestamps absent".into());
                }
                break;
            }
            if Instant::now() >= deadline {
                return Err("Owner did not observe process completion and UTF8 output".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
        let same = tool("run_command", args.clone())?;
        if same["status"] != "completed" {
            return Err("same process ID was replayed or lost".into());
        }
        if tool(
            "run_command",
            json!({"device_id":device_id,
            "operation_id":id,"command":"printf replayed","timeout_ms":0}),
        )?["status"]
            != "conflict"
        {
            return Err("different process intent did not conflict".into());
        }
        let operation = tool(
            "get_operation_status",
            json!({"device_id":device_id,"operation_id":id}),
        )?;
        if operation["status"] != "completed"
            || operation["receipt"]["tool_name"] != "start_process"
        {
            return Err("process receipt unavailable over Owner MCP".into());
        }
        let list = tool("list_sessions", json!({"device_id":device_id}))?;
        if list.as_array().is_none_or(|entries| entries.len() != 1) {
            return Err("process registry did not retain one owned session".into());
        }
        println!("REAL_WRANGLER_NATIVE_PROCESS_INPUT_OUTPUT_RECEIPTS_PASSED");

        let active = tool(
            "run_command",
            json!({"device_id":device_id,
            "operation_id":"p-real-revoke-start-914","command":"sleep 30","timeout_ms":0}),
        )?;
        if active["status"] != "running" {
            return Err("revoke exercise did not start".into());
        }
        let revoked = tool("revoke_device", json!({"device_id":device_id}))?;
        if revoked["status"] != "revoked" {
            return Err("Owner revoke not confirmed".into());
        }
        let check = client
            .post("http://127.0.0.1:8777/agent/session/challenge")
            .json(&json!({"device_id":device_id}))
            .send()
            .map_err(|_| "revoke challenge failed")?;
        if ![401, 403, 404].contains(&check.status().as_u16()) {
            return Err("revoked temporary device still authorized".into());
        }
        println!("REAL_WRANGLER_NATIVE_PROCESS_REVOKE_PASSED");
        Ok(())
    })();

    stop.store(true, Ordering::Release);
    let outcome = agent
        .join()
        .expect("native managed executor must not panic");
    assert!(
        matches!(
            outcome,
            Ok(())
                | Err(NativeFileError::Session(SessionError::Policy))
                | Err(NativeFileError::Session(SessionError::Ws(_)))
        ),
        "{outcome:?}"
    );
    assert_eq!(
        registry.stop_all(Duration::from_secs(2)),
        CleanupState::Confirmed
    );
    assert!(registry
        .list()
        .iter()
        .all(|s| s.state != SessionState::Running));
    assert!(result.is_ok(), "{result:?}");
}
