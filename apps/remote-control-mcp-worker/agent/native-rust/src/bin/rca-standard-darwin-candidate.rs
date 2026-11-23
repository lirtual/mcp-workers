//! Unshipped Standard macOS RCA entrypoint. No installed Agent path uses it.
//! The only supported state input is an existing owner-paired Node v2 identity.
#[cfg(target_os = "macos")]
mod darwin {
    use rca_native_agent::darwin_managed::DarwinManagedSessions;
    use rca_native_agent::identity::{signed_session_proof, valid_device_id};
    use rca_native_agent::native_file::{
        run_native_managed_session_with_upgrade, NativeFileError, UpgradeRuntimeOptions,
    };
    use rca_native_agent::session::SessionError;
    use std::ffi::OsStr;
    use std::fs;
    use std::io::{ErrorKind, Write};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    static SIGNAL_STOP: AtomicBool = AtomicBool::new(false);
    extern "C" fn request_stop(_: libc::c_int) {
        SIGNAL_STOP.store(true, Ordering::Release);
    }

    fn sidecar(key: &Path, suffix: &str) -> PathBuf {
        let mut name = key.as_os_str().to_os_string();
        name.push(OsStr::new(suffix));
        PathBuf::from(name)
    }

    fn private_regular(path: &Path, max_size: u64) -> Result<(), ()> {
        let info = fs::symlink_metadata(path).map_err(|_| ())?;
        if !info.is_file()
            || info.file_type().is_symlink()
            || info.uid() != unsafe { libc::geteuid() }
            || info.permissions().mode() & 0o077 != 0
            || info.len() == 0
            || info.len() > max_size
        {
            return Err(());
        }
        Ok(())
    }

    fn home() -> Result<PathBuf, ()> {
        let root = PathBuf::from(std::env::var_os("HOME").ok_or(())?);
        root.is_absolute().then_some(root).ok_or(())
    }

    fn key_path(home: &Path) -> Result<PathBuf, ()> {
        if let Some(explicit) = std::env::var_os("REMOTE_CONTROL_AGENT_KEY_PATH") {
            let path = PathBuf::from(explicit);
            return path.is_absolute().then_some(path).ok_or(());
        }
        Ok(home.join(".local/share/mcp-workers/remote-control/v2-identity.pem"))
    }

    fn owner_stopped(key: &Path) -> Result<bool, ()> {
        let marker = sidecar(key, ".owner-stopped");
        let info = match fs::symlink_metadata(marker) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(()),
            Ok(info) => info,
        };
        if !info.is_file()
            || info.file_type().is_symlink()
            || info.nlink() != 1
            || info.uid() != unsafe { libc::geteuid() }
            || info.permissions().mode() & 0o777 != 0o600
        {
            return Err(());
        }
        Ok(true)
    }

    fn record_connected(identity: &Path, generation: &str) -> Result<(), ()> {
        let directory = fs::symlink_metadata(identity).map_err(|_| ())?;
        if !directory.is_dir()
            || directory.file_type().is_symlink()
            || directory.uid() != unsafe { libc::geteuid() }
            || directory.permissions().mode() & 0o077 != 0
        {
            return Err(());
        }
        let marker = identity.join("macos-connection.json");
        match fs::symlink_metadata(&marker) {
            Ok(info)
                if info.is_file()
                    && !info.file_type().is_symlink()
                    && info.nlink() == 1
                    && info.uid() == unsafe { libc::geteuid() }
                    && info.permissions().mode() & 0o777 == 0o600 => {}
            Ok(_) => return Err(()),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(()),
        }
        let temporary = identity.join(format!(".connection-{generation}-{}", std::process::id()));
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| ())?
            .as_millis();
        let record = serde_json::json!({
            "generation": generation,
            "version": "rust-candidate",
            "pid": std::process::id(),
            "state": "connected",
            "at": now
        });
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| ())?;
        if file.write_all(record.to_string().as_bytes()).is_err()
            || file.write_all(b"\n").is_err()
            || file.sync_all().is_err()
        {
            let _ = fs::remove_file(&temporary);
            return Err(());
        }
        fs::rename(&temporary, &marker).map_err(|_| ())
    }

    #[cfg(test)]
    mod connection_marker_tests {
        use super::*;

        #[test]
        fn rust_connection_marker_is_owner_private_json_with_a_newline() {
            let dir = tempfile::tempdir().unwrap();
            record_connected(dir.path(), "candidate-generation").unwrap();
            let marker = dir.path().join("macos-connection.json");
            let raw = fs::read_to_string(&marker).unwrap();
            assert!(raw.ends_with('\n'));
            let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(value["state"], "connected");
            assert_eq!(value["generation"], "candidate-generation");
            assert!(value["at"].as_u64().is_some());
            assert_eq!(
                fs::symlink_metadata(marker).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    fn checked_supervisor() -> Result<Arc<DarwinManagedSessions>, ()> {
        // Candidate bundle layout only. The installed Node release is untouched.
        let helper = std::env::current_exe()
            .map_err(|_| ())?
            .with_file_name("darwin-session-supervisor");
        let meta = fs::symlink_metadata(&helper).map_err(|_| ())?;
        if !helper.is_absolute()
            || !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.nlink() != 1
            || meta.permissions().mode() & 0o022 != 0
            || meta.permissions().mode() & 0o6000 != 0
            || meta.permissions().mode() & 0o111 == 0
            || fs::canonicalize(&helper).ok().as_deref() != Some(helper.as_path())
        {
            return Err(());
        }
        DarwinManagedSessions::new(&helper, Path::new("/bin/sh"), Duration::from_secs(60 * 60))
            .map(Arc::new)
            .map_err(|_| ())
    }

    fn standard_receipts(home: &Path) -> Result<PathBuf, ()> {
        // Node creates this hierarchy recursively on the first authenticated
        // start. Rust's shared receipt store creates only the final leaf.
        let mut parent = home.to_path_buf();
        for part in [".local", "state", "mcp-workers"] {
            parent.push(part);
            match fs::symlink_metadata(&parent) {
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    fs::create_dir(&parent).map_err(|_| ())?;
                    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700))
                        .map_err(|_| ())?;
                }
                Err(_) => return Err(()),
                Ok(_) => {}
            }
            let info = fs::symlink_metadata(&parent).map_err(|_| ())?;
            // Existing Node installations can have traversable 0755
            // ancestors; reject writable or redirected ancestors.
            if !info.is_dir()
                || info.file_type().is_symlink()
                || info.uid() != unsafe { libc::geteuid() }
                || info.permissions().mode() & 0o022 != 0
            {
                return Err(());
            }
        }
        Ok(parent.join("remote-control-agent"))
    }

    fn install_stop_signals() -> Result<(), ()> {
        unsafe {
            if libc::signal(
                libc::SIGINT,
                request_stop as *const () as libc::sighandler_t,
            ) == libc::SIG_ERR
                || libc::signal(
                    libc::SIGTERM,
                    request_stop as *const () as libc::sighandler_t,
                ) == libc::SIG_ERR
            {
                return Err(());
            }
        }
        Ok(())
    }

    pub fn run() -> Result<(), ()> {
        let arguments: Vec<String> = std::env::args_os()
            .skip(1)
            .map(|value| value.into_string().map_err(|_| ()))
            .collect::<Result<_, _>>()?;
        if unsafe { libc::geteuid() } == 0
            || arguments.len() != 5
            || arguments[0] != "--service"
            || arguments[1] != "--endpoint"
            || arguments[3] != "--generation"
            || !valid_device_id(&arguments[4])
        {
            return Err(());
        }
        let endpoint = arguments[2].clone();
        let generation = arguments[4].clone();
        let home = home()?;
        let key = key_path(&home)?;
        private_regular(&key, 8192)?;
        private_regular(&sidecar(&key, ".device-id"), 128)?;
        if owner_stopped(&key)? {
            eprintln!(r#"{{"service":"remote-control-agent","event":"owner_stopped"}}"#);
            return Ok(());
        }
        let device_id = fs::read_to_string(sidecar(&key, ".device-id")).map_err(|_| ())?;
        let device_id = device_id.trim();
        if !valid_device_id(device_id) {
            return Err(());
        }
        let private_pem = fs::read_to_string(&key).map_err(|_| ())?;
        // Local PEM validation before any receipt ownership or network I/O.
        signed_session_proof(&private_pem, device_id, "ABCDEFGHIJKLMNOPQRSTUVWX")
            .map_err(|_| ())?;
        let managed = checked_supervisor()?;
        // Fail closed before creating Node's existing SQLite receipt directory.
        rca_native_agent::upgrade_control::verify_upgrade_directory(&key).map_err(|_| ())?;
        unsafe {
            libc::umask(0o077);
        }
        let receipts = standard_receipts(&home)?;
        install_stop_signals()?;
        let stop = Arc::new(AtomicBool::new(false));
        let watch_stop = Arc::clone(&stop);
        let monitor = std::thread::spawn(move || {
            while !watch_stop.load(Ordering::Acquire) {
                if SIGNAL_STOP.load(Ordering::Acquire) {
                    watch_stop.store(true, Ordering::Release);
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        // Exactly the existing Node default receipt location; never create a
        // parallel receipt ledger when switching the runtime.
        let marker_identity = key.parent().ok_or(())?.to_path_buf();
        let marker_generation = generation.clone();
        let on_connected: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            let _ = record_connected(&marker_identity, &marker_generation);
        });
        let result = run_native_managed_session_with_upgrade(
            &endpoint,
            &private_pem,
            device_id,
            &receipts,
            managed,
            &stop,
            UpgradeRuntimeOptions {
                key_path: &key,
                on_connected: Some(on_connected),
            },
        );
        stop.store(true, Ordering::Release);
        monitor.join().map_err(|_| ())?;
        match result {
            Ok(()) | Err(NativeFileError::Session(SessionError::Policy)) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

#[cfg(target_os = "macos")]
fn main() {
    if darwin::run().is_err() {
        eprintln!(r#"{{"service":"remote-control-agent","event":"startup_unavailable"}}"#);
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Unshipped Standard macOS Agent is macOS-only.");
    std::process::exit(1);
}
