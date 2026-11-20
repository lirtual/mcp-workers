//! Opt-in real Wrangler + SQLite Durable Object + Owner MCP + native Rust read.
//! The external setup supplies an isolated, throwaway paired test identity.
//! No production URL, credential, device or persisted state is accepted.
use rca_native_agent::native_read::{run_native_read_session, NativeReadRuntimeError};
use rca_native_agent::session::{HeartbeatTiming, SessionError};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[test]
#[ignore = "requires the isolated local Wrangler/SQLite DO and approved disposable test identity"]
fn actual_owner_mcp_read_file_roundtrips_through_sqlite_do_and_native_rust() {
    let root = std::env::var("RCA_LOCAL_NATIVE_READ_ROOT").expect("explicit test root required");
    let root = Path::new(&root);
    assert!(
        root.parent() == Some(Path::new("/tmp"))
            && root
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("rca-gate1-read-"))
    );
    let meta = std::fs::symlink_metadata(root).unwrap();
    assert!(meta.is_dir() && !meta.file_type().is_symlink());
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let uid = unsafe { libc::geteuid() };
        assert_eq!(meta.uid(), uid);
        assert_eq!(
            meta.permissions().mode() & 0o077,
            0,
            "test root must be owner-private"
        );
        for name in [
            "native-test-key.pem",
            "device-id",
            "owner-token",
            "marker.txt",
        ] {
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
    assert!(device_id.len() == 36 && owner_token.len() >= 32);
    let path = root.join("marker.txt");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "RCA_RUST_NATIVE_READ_WORKER_OK\n"
    );
    let endpoint = "http://127.0.0.1:8777/";
    let stop = Arc::new(AtomicBool::new(false));
    let agent_stop = Arc::clone(&stop);
    let agent_pem = pem.clone();
    let agent_id = device_id.to_owned();
    let agent = thread::spawn(move || {
        run_native_read_session(
            endpoint,
            &agent_pem,
            &agent_id,
            &agent_stop,
            HeartbeatTiming::default(),
        )
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap();
    let mcp = "http://127.0.0.1:8777/mcp";
    let rpc = |name: &str, args: Value, token: &str| {
        client
            .post(mcp)
            .header("authorization", format!("Bearer {token}"))
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                "params":{"name":name,"arguments":args}}))
            .send()
            .unwrap()
    };
    let result = (|| -> Result<(), String> {
        let deny = rpc(
            "read_file",
            json!({"device_id":device_id,"path":path}),
            "invalid-test-token",
        );
        if deny.status().as_u16() != 401 {
            return Err(format!("unauthorized Owner status {}", deny.status()));
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        let body = loop {
            let response = rpc(
                "read_file",
                json!({"device_id":device_id,"path":path,
                "offset":0,"length":1}),
                owner_token,
            );
            if response.status().as_u16() != 200 {
                return Err(format!("Owner read HTTP {}", response.status()));
            }
            let body: Value = response.json().map_err(|_| "Owner reply JSON invalid")?;
            if body["result"]["isError"] == Value::Bool(false) {
                break body;
            }
            if Instant::now() >= deadline {
                return Err("Owner stayed offline or read failed".into());
            }
            thread::sleep(Duration::from_millis(300));
        };
        let text = body["result"]["content"][0]["text"].as_str().unwrap_or("");
        if text != "RCA_RUST_NATIVE_READ_WORKER_OK" {
            return Err("Owner MCP did not receive the complete Rust read_file text".into());
        }
        println!("REAL_WORKER_NATIVE_READ_OWNER_ROUNDTRIP_PASSED");

        let revoke = rpc("revoke_device", json!({"device_id":device_id}), owner_token);
        let revoke_body: Value = revoke.json().map_err(|_| "Owner revoke reply invalid")?;
        let text = revoke_body["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("");
        if !text.contains("revoked") {
            return Err("Owner revoke did not settle".into());
        }
        let challenge = client
            .post("http://127.0.0.1:8777/agent/session/challenge")
            .json(&json!({"device_id":device_id}))
            .send()
            .map_err(|_| "challenge request failed")?;
        if ![401, 403, 404].contains(&challenge.status().as_u16()) {
            return Err("revoked identity was not denied a fresh challenge".into());
        }
        println!("REAL_WORKER_NATIVE_READ_REVOKE_REJECT_PASSED");
        Ok(())
    })();
    stop.store(true, Ordering::Release);
    let agent_result = agent.join().expect("Rust read executor must not panic");
    assert!(
        matches!(
            agent_result,
            Ok(())
                | Err(NativeReadRuntimeError::Session(SessionError::Policy))
                | Err(NativeReadRuntimeError::Session(SessionError::Ws(_)))
        ),
        "{agent_result:?}"
    );
    assert!(result.is_ok(), "{result:?}");
}
