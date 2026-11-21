//! Real subprocess seam for an unshipped Standard Linux Rust Agent.
//! Every fixture uses disposable owner-private identity files and no live endpoint.
#[cfg(target_os = "linux")]
mod common;

#[cfg(target_os = "linux")]
mod linux {
    use crate::common;
    use std::fs;
    use std::io::Read;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::os::unix::net::UnixListener;
    use std::path::Path;
    use std::process::{Command, Output};

    const ID: &str = "123e4567-e89b-42d3-a456-426614174001";

    fn private_file(path: &Path, content: &str) {
        fs::write(path, content).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn invoke(home: &Path, key: &Path) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rca-standard-linux-candidate"))
            .env_clear()
            .env("HOME", home)
            .env("REMOTE_CONTROL_AGENT_KEY_PATH", key)
            .env("REMOTE_CONTROL_AGENT_ENDPOINT", "http://127.0.0.1:1/")
            .output()
            .unwrap()
    }

    fn identity(root: &Path) -> std::path::PathBuf {
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
        let key = root.join("v2-identity.pem");
        private_file(&key, &common::test_pem());
        private_file(&root.join("v2-identity.pem.device-id"), &format!("{ID}\n"));
        key
    }

    fn receipts(home: &Path) -> std::path::PathBuf {
        home.join(".local/state/mcp-workers/remote-control-agent")
    }

    fn refused(output: &Output, home: &Path) {
        assert!(!output.status.success());
        let log: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(log["service"], "remote-control-agent");
        assert_eq!(log["event"], "startup_unavailable");
        assert!(
            !receipts(home).exists(),
            "must not open receipts on rejected input"
        );
    }

    #[test]
    fn existing_owner_stop_prevents_any_transport_or_receipt_execution() {
        let root = tempfile::tempdir().unwrap();
        let key = root.path().join("v2-identity.pem");
        private_file(&key, "disposable-unpaired-private-key");
        private_file(
            &root.path().join("v2-identity.pem.device-id"),
            &format!("{ID}\n"),
        );
        private_file(
            &root.path().join("v2-identity.pem.owner-stopped"),
            "stopped\n",
        );
        let output = invoke(root.path(), &key);
        assert!(output.status.success());
        let log: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(log["service"], "remote-control-agent");
        assert_eq!(log["event"], "owner_stopped");
        assert!(!receipts(root.path()).exists());
    }

    #[test]
    fn unsafe_owner_stop_never_becomes_an_implicit_restart() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(root.path());
        private_file(&root.path().join("other"), "stopped");
        symlink("other", root.path().join("v2-identity.pem.owner-stopped")).unwrap();
        refused(&invoke(root.path(), &key), root.path());
    }

    #[test]
    fn world_readable_identity_is_rejected_before_receipts() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(root.path());
        fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).unwrap();
        refused(&invoke(root.path(), &key), root.path());
    }

    #[test]
    fn invalid_existing_device_id_is_rejected_before_receipts() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(root.path());
        private_file(
            &root.path().join("v2-identity.pem.device-id"),
            "not-a-uuid\n",
        );
        refused(&invoke(root.path(), &key), root.path());
    }

    #[test]
    fn malformed_existing_pem_is_rejected_before_receipts() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(root.path());
        private_file(&key, "not-an-ed25519-pkcs8-key");
        refused(&invoke(root.path(), &key), root.path());
    }

    #[test]
    fn missing_bundled_supervisor_fails_before_receipts_or_network() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(root.path());
        // Execute a copy outside the build tree so the sibling helper cannot exist.
        let bin = root.path().join("rca-standard-linux-candidate");
        fs::copy(env!("CARGO_BIN_EXE_rca-standard-linux-candidate"), &bin).unwrap();
        let output = Command::new(&bin)
            .env_clear()
            .env("HOME", root.path())
            .env("REMOTE_CONTROL_AGENT_KEY_PATH", &key)
            .env("REMOTE_CONTROL_AGENT_ENDPOINT", "http://127.0.0.1:1/")
            .output()
            .unwrap();
        refused(&output, root.path());
    }

    #[test]
    fn fresh_standard_home_uses_node_receipt_directory_and_stops_on_sigterm() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(root.path());
        let bin = root.path().join("rca-standard-linux-candidate");
        fs::copy(env!("CARGO_BIN_EXE_rca-standard-linux-candidate"), &bin).unwrap();
        // Only executable trust is under test; there are no incoming process
        // operations, so the disposable sibling is never invoked.
        let helper = root.path().join("session-supervisor");
        fs::copy(&bin, &helper).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = Command::new(&bin)
            .env_clear()
            .env("HOME", root.path())
            .env("REMOTE_CONTROL_AGENT_KEY_PATH", &key)
            .env("REMOTE_CONTROL_AGENT_ENDPOINT", "http://127.0.0.1:1/")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let db = receipts(root.path()).join("operation-receipts.sqlite");
        let mut opened = false;
        for _ in 0..100 {
            if db.exists() && root.path().join("upgrade.sock").exists() {
                opened = true;
                break;
            }
            if let Some(status) = child.try_wait().unwrap() {
                let mut log = String::new();
                child
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut log)
                    .unwrap();
                panic!("candidate exited before opening the existing Node receipt path: {status} {log}");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
        let result = child.wait().unwrap();
        assert!(
            opened,
            "fresh Node-compatible receipt directory was not created"
        );
        assert!(result.success(), "SIGTERM must complete cleanly");
    }

    #[test]
    fn active_node_upgrade_listener_is_not_replaced_by_rust_candidate() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(root.path());
        let bin = root.path().join("rca-standard-linux-candidate");
        fs::copy(env!("CARGO_BIN_EXE_rca-standard-linux-candidate"), &bin).unwrap();
        let helper = root.path().join("session-supervisor");
        fs::copy(&bin, &helper).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = root.path().join("upgrade.sock");
        let _node = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let result = Command::new(&bin)
            .env_clear()
            .env("HOME", root.path())
            .env("REMOTE_CONTROL_AGENT_KEY_PATH", &key)
            .env("REMOTE_CONTROL_AGENT_ENDPOINT", "http://127.0.0.1:1/")
            .output()
            .unwrap();
        assert!(
            !result.status.success(),
            "live Node control must block Rust"
        );
        assert!(
            socket.exists(),
            "must not steal or unlink the Node listener"
        );
    }

    #[test]
    fn unsafe_identity_directory_rejects_upgrade_listener() {
        let root = tempfile::tempdir().unwrap();
        let key = identity(root.path());
        let bin = root.path().join("rca-standard-linux-candidate");
        fs::copy(env!("CARGO_BIN_EXE_rca-standard-linux-candidate"), &bin).unwrap();
        let helper = root.path().join("session-supervisor");
        fs::copy(&bin, &helper).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
        let output = Command::new(&bin)
            .env_clear()
            .env("HOME", root.path())
            .env("REMOTE_CONTROL_AGENT_KEY_PATH", &key)
            .env("REMOTE_CONTROL_AGENT_ENDPOINT", "http://127.0.0.1:1/")
            .output()
            .unwrap();
        refused(&output, root.path());
        assert!(!root.path().join("upgrade.sock").exists());
    }

    #[test]
    fn redirected_receipt_ancestor_fails_before_opening_database_or_transport() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let key = identity(root.path());
        let bin = root.path().join("rca-standard-linux-candidate");
        fs::copy(env!("CARGO_BIN_EXE_rca-standard-linux-candidate"), &bin).unwrap();
        let helper = root.path().join("session-supervisor");
        fs::copy(&bin, &helper).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(outside.path(), root.path().join(".local")).unwrap();
        let output = Command::new(&bin)
            .env_clear()
            .env("HOME", root.path())
            .env("REMOTE_CONTROL_AGENT_KEY_PATH", &key)
            .env("REMOTE_CONTROL_AGENT_ENDPOINT", "http://127.0.0.1:1/")
            .output()
            .unwrap();
        refused(&output, root.path());
        assert!(!outside.path().join("state").exists());
    }
}
