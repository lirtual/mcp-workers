//! Opt-in Owner MCP -> real local Wrangler -> separate Rust CLI process.
//! Requires a newly paired, disposable temporary Grant. Never uses a real device.
#![cfg(target_os = "linux")]

use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

struct ScopedChild(Child);

impl Drop for ScopedChild {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn fixture() -> (String, String, String) {
    let root = std::env::var("RCA_LOCAL_NATIVE_FILE_ROOT")
        .expect("explicit local Wrangler disposable fixture required");
    let root = Path::new(&root);
    assert!(
        root.parent() == Some(Path::new("/tmp"))
            && root
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("rca-gate1-file-"))
    );
    let metadata = fs::symlink_metadata(root).unwrap();
    assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(metadata.permissions().mode() & 0o077, 0);
    for name in ["native-test-key.pem", "device-id", "owner-token"] {
        let meta = fs::symlink_metadata(root.join(name)).unwrap();
        assert!(meta.is_file() && !meta.file_type().is_symlink());
        assert_eq!(meta.uid(), unsafe { libc::geteuid() });
        assert_eq!(meta.nlink(), 1);
        assert!(meta.len() > 0 && meta.len() <= 8192);
        assert_eq!(meta.permissions().mode() & 0o077, 0);
    }
    (
        fs::read_to_string(root.join("native-test-key.pem")).unwrap(),
        fs::read_to_string(root.join("device-id"))
            .unwrap()
            .trim()
            .to_owned(),
        fs::read_to_string(root.join("owner-token"))
            .unwrap()
            .trim()
            .to_owned(),
    )
}

fn owner_call(client: &reqwest::blocking::Client, token: &str, name: &str, args: Value) -> Value {
    let reply = client
        .post("http://127.0.0.1:8777/mcp")
        .bearer_auth(token)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":name,"arguments":args}}))
        .send()
        .expect("isolated Wrangler Owner MCP");
    assert_eq!(reply.status().as_u16(), 200, "Owner HTTP status");
    let body: Value = reply.json().unwrap();
    assert_ne!(body["result"]["isError"], true, "{name}: {body}");
    let text = body["result"]["content"][0]["text"]
        .as_str()
        .expect("Owner tool text result");
    if name == "read_file" {
        Value::String(text.to_owned())
    } else {
        serde_json::from_str(text).expect("Owner tool JSON result")
    }
}

#[test]
#[ignore = "requires local Wrangler/SQLite DO and disposable approved test identity"]
fn owner_file_receipt_and_sigterm_reach_real_cli_process() {
    let (pem, device_id, owner_token) = fixture();
    assert_eq!(device_id.len(), 36);
    assert!(owner_token.len() >= 32);

    // Make a separate process-only, private root; do not expose the fixture
    // identity or share the installed Agent's receipts.
    let root = tempfile::Builder::new()
        .prefix("rca-rust-probe-cli-owner-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let key = root.path().join("gate0-test-key.pem");
    fs::write(&key, pem).unwrap();
    fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();

    let mut child = ScopedChild(
        Command::new(env!("CARGO_BIN_EXE_rca-native-nonprod"))
            .args(["--local", &device_id])
            .arg(root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .expect("start real Linux Rust CLI"),
    );
    let target = root.path().join("owner-cli-created.txt");
    let request = json!({"device_id":device_id, "operation_id":"cli-owner-write-001",
        "path":target, "content":"real CLI Owner write", "mode":"rewrite"});
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let ready_deadline = Instant::now() + Duration::from_secs(35);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            panic!("native CLI exited before Owner write: {status}");
        }
        let answer = owner_call(&client, &owner_token, "write_file", request.clone());
        if answer["status"] == "completed" {
            break;
        }
        assert!(
            answer["status"] == "offline" || answer["status"] == "busy",
            "unexpected Owner write: {answer}"
        );
        assert!(
            Instant::now() < ready_deadline,
            "CLI did not become Owner-ready"
        );
        thread::sleep(Duration::from_millis(250));
    }
    assert_eq!(fs::read_to_string(&target).unwrap(), "real CLI Owner write");
    assert_eq!(
        owner_call(
            &client,
            &owner_token,
            "get_operation_status",
            json!({"device_id":device_id,"operation_id":"cli-owner-write-001"})
        )["status"],
        "completed"
    );
    fs::write(&target, "changed after durable receipt").unwrap();
    assert_eq!(
        owner_call(&client, &owner_token, "write_file", request)["status"],
        "completed"
    );
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "changed after durable receipt",
        "duplicate ID must not replay the file write"
    );
    let conflict = owner_call(
        &client,
        &owner_token,
        "write_file",
        json!({"device_id":device_id, "operation_id":"cli-owner-write-001",
            "path":target, "content":"MUST-NOT-WRITE", "mode":"rewrite"}),
    );
    assert_eq!(conflict["status"], "conflict");
    assert_eq!(
        owner_call(
            &client,
            &owner_token,
            "read_file",
            json!({"device_id":device_id,"path":target})
        ),
        "changed after durable receipt"
    );
    let receipt_path = root.path().join("receipts/operation-receipts.sqlite");

    assert_eq!(
        unsafe { libc::kill(child.0.id() as libc::pid_t, libc::SIGTERM) },
        0
    );
    let stop_deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "SIGTERM must end cleanly: {status}");
            break;
        }
        assert!(
            Instant::now() < stop_deadline,
            "CLI did not stop after SIGTERM"
        );
        thread::sleep(Duration::from_millis(50));
    }
    let persisted = fs::metadata(&receipt_path).expect("durable SQLite receipt after CLI exit");
    assert!(persisted.is_file() && persisted.len() > 0);
    assert_eq!(persisted.permissions().mode() & 0o077, 0);
    println!("REAL_WRANGLER_OWNER_TO_CLI_RECEIPT_NO_REPLAY_SIGTERM_PASSED");
}
