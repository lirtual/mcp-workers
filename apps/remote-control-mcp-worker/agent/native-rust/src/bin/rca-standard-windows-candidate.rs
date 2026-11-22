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

    fn record_connected(root: &Path, generation: &str) -> Result<(), ()> {
        let path = root.join(format!(".windows-connected-{generation}.json"));
        let record = serde_json::json!({
            "generation": generation,
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
            || std::env::args_os().len() != 6
            || rca_native_agent::is_windows_system_identity().map_err(|_| ())?
        {
            return Err(());
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
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
        let identity = read_private(&key, 8_192)?;
        if stopped(&key)? {
            return Ok(());
        }
        let id_path = PathBuf::from(format!("{}.device-id", key.display()));
        let id = String::from_utf8(read_private(&id_path, 256)?).map_err(|_| ())?;
        let device_id = id.trim();
        if !valid_device_id(device_id) {
            return Err(());
        }
        let private_pem = String::from_utf8(identity).map_err(|_| ())?;
        signed_session_proof(&private_pem, device_id).map_err(|_| ())?;
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
        let on_connected: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = record_connected(&marker_root, &marker_generation);
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
