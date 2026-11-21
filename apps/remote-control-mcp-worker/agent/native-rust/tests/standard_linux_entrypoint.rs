//! Real subprocess seam for an unshipped Standard Linux Rust Agent.
//! Every fixture uses disposable owner-private identity files and no live endpoint.
#[cfg(target_os = "linux")]
mod common;

#[cfg(target_os = "linux")]
mod linux {
    use crate::common;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
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
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("startup_unavailable"),
            "unexpected failure: {:?}",
            output.stderr
        );
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
        assert!(String::from_utf8_lossy(&output.stderr).contains("owner_stopped"));
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
}
