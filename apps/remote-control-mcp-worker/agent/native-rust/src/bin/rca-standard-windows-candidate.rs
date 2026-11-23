//! Unshipped Standard Windows RCA entrypoint. It accepts only an existing
//! owner-paired identity and an explicit same-owner service launch contract.
#[cfg(windows)]
mod windows {
    use rca_native_agent::identity::{signed_session_proof, valid_device_id};
    use rca_native_agent::native_file::{
        run_native_managed_session_with_upgrade, NativeFileError, UpgradeRuntimeOptions,
    };
    use rca_native_agent::session::SessionError;
    use rca_native_agent::validate_windows_private_path;
    use rca_native_agent::windows_managed::WindowsManagedSessions;
    use std::fs;
    use std::io::{ErrorKind, Write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    fn store_root() -> Result<PathBuf, ()> {
        let base = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or(())?);
        if !base.is_absolute() {
            return Err(());
        }
        Ok(base.join("mcp-workers").join("remote-control"))
    }

    fn key_path(root: &Path) -> Result<PathBuf, ()> {
        if let Some(value) = std::env::var_os("REMOTE_CONTROL_AGENT_KEY_PATH") {
            let path = PathBuf::from(value);
            return path.is_absolute().then_some(path).ok_or(());
        }
        Ok(root.join("v2-identity.pem"))
    }

    fn read_private(path: &Path, max: u64) -> Result<Vec<u8>, ()> {
        let meta = fs::symlink_metadata(path).map_err(|_| ())?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 || meta.len() > max {
            return Err(());
        }
        validate_windows_private_path(path, false).map_err(|_| ())?;
        fs::read(path).map_err(|_| ())
    }

    fn optional_private(path: &Path, max: u64) -> Result<Option<Vec<u8>>, ()> {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
            Ok(_) => read_private(path, max).map(Some),
        }
    }

    // The service and management CLI use the same identity parser. Status
    // neither creates state nor requests authorization or a network connection.
    fn local_identity(key: &Path) -> Result<(Option<String>, Option<String>), ()> {
        let pem = optional_private(key, 8192)?
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| ())?;
        let id_path = PathBuf::from(format!("{}.device-id", key.display()));
        let id = optional_private(&id_path, 256)?
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| ())?
            .map(|value| value.trim().to_owned());
        match (&pem, &id) {
            (Some(pem), Some(id)) => {
                signed_session_proof(pem, id, "000000000000000000000000").map_err(|_| ())?;
            }
            (None, Some(_)) => return Err(()),
            _ => {}
        }
        Ok((pem, id))
    }

    fn local_status() -> Result<(), ()> {
        let root = store_root()?;
        match fs::symlink_metadata(&root) {
            Ok(_) => validate_windows_private_path(&root, true).map_err(|_| ())?,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(()),
        }
        let (pem, id) = local_identity(&root.join("v2-identity.pem"))?;
        println!(
            "{}",
            serde_json::json!({
                "platform": "win32",
                "mode": "native-user-agent",
                "identity_present": pem.is_some(),
                "device_id": id,
                "remote_connection": "unconfirmed",
                "shell": true,
                "write_file": true
            })
        );
        Ok(())
    }

    fn stopped(key: &Path) -> Result<bool, ()> {
        let marker = PathBuf::from(format!("{}.owner-stopped", key.display()));
        match fs::symlink_metadata(&marker) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(_) => Err(()),
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                validate_windows_private_path(&marker, false).map_err(|_| ())?;
                Ok(true)
            }
            Ok(_) => Err(()),
        }
    }

    // Evidence of a handshake, not present network liveness. The task
    // controller additionally verifies the actual process and generation.
    fn activation_proof(generation: &str) -> Result<(), ()> {
        if !valid_device_id(generation) {
            return Err(());
        }
        let root = store_root()?;
        validate_windows_private_path(&root, true).map_err(|_| ())?;
        let (_, id) = local_identity(&root.join("v2-identity.pem"))?;
        let id = id.ok_or(())?;
        let path = root.join(format!(".windows-connected-{generation}.json"));
        let proof: serde_json::Value =
            serde_json::from_slice(&read_private(&path, 4096)?).map_err(|_| ())?;
        if proof["generation"].as_str() != Some(generation)
            || proof["device_id"].as_str() != Some(id.as_str())
            || proof["state"].as_str() != Some("connected")
            || !matches!(proof["pid"].as_u64(), Some(pid) if pid > 0 && pid <= u64::from(u32::MAX))
            || !matches!(proof["at"].as_u64(), Some(at) if at > 0)
        {
            return Err(());
        }
        println!(
            "{}",
            serde_json::json!({
                "generation": generation,
                "device_id": id,
                "state": "connected",
                "pid": proof["pid"],
                "at": proof["at"],
            })
        );
        Ok(())
    }

    fn record_connected(root: &Path, generation: &str, device_id: &str) -> Result<(), ()> {
        let path = root.join(format!(".windows-connected-{generation}.json"));
        let record = serde_json::json!({
            "generation": generation,
            "device_id": device_id,
            "pid": std::process::id(),
            "state": "connected",
            "at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).map_err(|_| ())?.as_millis()
        });
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| ())?;
        file.write_all(record.to_string().as_bytes())
            .map_err(|_| ())?;
        file.write_all(b"\n").map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        validate_windows_private_path(&path, false).map_err(|_| ())?;
        Ok(())
    }

    pub fn run() -> Result<(), ()> {
        if !cfg!(target_arch = "x86_64")
            || rca_native_agent::is_windows_system_identity().map_err(|_| ())?
        {
            return Err(());
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.first().map(String::as_str) == Some("--cli") {
            return if args.as_slice() == ["--cli", "status"] {
                local_status()
            } else {
                Err(())
            };
        }
        if let [command, generation] = args.as_slice() {
            if command == "--verify-activation-proof" {
                return activation_proof(generation);
            }
        }
        let [mode, endpoint_flag, endpoint, generation_flag, generation] = args.as_slice() else {
            return Err(());
        };
        if mode != "--service"
            || endpoint_flag != "--endpoint"
            || generation_flag != "--generation"
            || !valid_device_id(generation)
            || !(endpoint.starts_with("https://")
                && endpoint.ends_with('/')
                && endpoint[8..endpoint.len() - 1]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':')))
        {
            return Err(());
        }
        let root = store_root()?;
        let key = key_path(&root)?;
        if !key.starts_with(&root) {
            return Err(());
        }
        // Owner STOP preserves the existing behavior even if the ID is missing.
        if stopped(&key)? {
            read_private(&key, 8192)?;
            return Ok(());
        }
        let (pem, id) = local_identity(&key)?;
        let id = id.ok_or(())?;
        let private_pem = pem.ok_or(())?;
        let device_id = id.as_str();
        let receipts = root.join("receipts");
        let meta = fs::symlink_metadata(&receipts).map_err(|_| ())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(());
        }
        validate_windows_private_path(&receipts, true).map_err(|_| ())?;
        let managed =
            Arc::new(WindowsManagedSessions::new(Duration::from_secs(60 * 60)).map_err(|_| ())?);
        let stop = Arc::new(AtomicBool::new(false));
        let marker_root = root.clone();
        let marker_generation = generation.clone();
        let marker_id = id.clone();
        let on_connected: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = record_connected(&marker_root, &marker_generation, &marker_id);
        });
        let outcome = run_native_managed_session_with_upgrade(
            endpoint,
            &private_pem,
            device_id,
            &receipts,
            Arc::clone(&managed),
            &stop,
            UpgradeRuntimeOptions {
                key_path: &key,
                on_connected: Some(on_connected),
            },
        );
        stop.store(true, Ordering::Release);
        if managed.stop_all(Duration::from_secs(8))
            != rca_native_agent::windows_job::JobCleanup::Confirmed
        {
            return Err(());
        }
        match outcome {
            Ok(()) => Ok(()),
            Err(NativeFileError::Session(SessionError::Policy)) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

#[cfg(windows)]
fn main() {
    if windows::run().is_err() {
        eprintln!("Windows Rust candidate refused or session failed.");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows Rust candidate requires Windows x64.");
    std::process::exit(1);
}
