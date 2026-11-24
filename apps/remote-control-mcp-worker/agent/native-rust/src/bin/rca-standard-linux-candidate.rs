//! Unshipped Standard Linux RCA entrypoint. No installed Agent path uses it.
//! The only supported state input is an existing owner-paired Node v2 identity.
#[cfg(target_os = "linux")]
mod linux {
    use rca_native_agent::identity::{signed_session_proof, valid_device_id};
    use rca_native_agent::linux_managed::LinuxManagedSessions;
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

    // The only success proof for a local Node -> native service cutover.
    // Called by the shared transport *after* a signed Worker WSS handshake,
    // never by systemd readiness or by a local upgrade command.
    fn write_upgrade_proof(key: &Path, device_id: &str, executable: &Path) -> Result<(), ()> {
        let intent_path = sidecar(key, ".native-upgrade-intent");
        let info = match fs::symlink_metadata(&intent_path) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(()),
            Ok(info) => info,
        };
        if info.nlink() != 1 || info.permissions().mode() & 0o777 != 0o600 {
            return Err(());
        }
        private_regular(&intent_path, 512)?;
        let data: serde_json::Value =
            serde_json::from_slice(&fs::read(&intent_path).map_err(|_| ())?).map_err(|_| ())?;
        let fields = data.as_object().ok_or(())?;
        if fields.len() != 3 {
            return Err(());
        }
        let operation = fields
            .get("operation_id")
            .and_then(|x| x.as_str())
            .ok_or(())?;
        let expected_id = fields.get("device_id").and_then(|x| x.as_str()).ok_or(())?;
        let target = fields
            .get("target_version")
            .and_then(|x| x.as_str())
            .ok_or(())?;
        if operation.len() != 32
            || !operation
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || expected_id != device_id
        {
            return Err(());
        }
        let root = executable
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or(())?;
        if root.file_name().and_then(OsStr::to_str) != Some(target) {
            return Err(());
        }
        let manifest_path = root.join("bundle.json");
        private_regular(&manifest_path, 4096)?;
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(manifest_path).map_err(|_| ())?).map_err(|_| ())?;
        if manifest["artifact_profile"] != "rust-native-only-v1"
            || manifest["agent_runtime"] != "rust-standard-linux-v1"
            || format!(
                "{}-{}",
                manifest["version"].as_str().ok_or(())?,
                manifest["target"].as_str().ok_or(())?
            ) != target
        {
            return Err(());
        }
        let proof = sidecar(key, ".native-upgrade-proof");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&proof)
            .map_err(|_| ())?;
        serde_json::to_writer(
            &mut file,
            &serde_json::json!({
                "operation_id": operation, "device_id": device_id,
                "target_version": target, "status": "authenticated_wss", "pid": std::process::id(),
            }),
        )
        .map_err(|_| ())?;
        file.write_all(b"\n").map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        fs::File::open(key.parent().ok_or(())?)
            .map_err(|_| ())?
            .sync_all()
            .map_err(|_| ())?;
        Ok(())
    }

    fn checked_supervisor() -> Result<Arc<LinuxManagedSessions>, ()> {
        // Candidate bundle layout only. The installed Node release is untouched.
        let helper = std::env::current_exe()
            .map_err(|_| ())?
            .with_file_name("session-supervisor");
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
        LinuxManagedSessions::new(
            &helper,
            Path::new("/bin/bash"),
            Duration::from_secs(60 * 60),
        )
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
        if unsafe { libc::geteuid() } == 0 || std::env::args_os().len() != 1 {
            return Err(());
        }
        let endpoint = std::env::var("REMOTE_CONTROL_AGENT_ENDPOINT").map_err(|_| ())?;
        if endpoint.is_empty() {
            return Err(());
        }
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
        let proof_key = key.clone();
        let proof_id = device_id.to_owned();
        let proof_exe = std::env::current_exe().map_err(|_| ())?;
        let result = run_native_managed_session_with_upgrade(
            &endpoint,
            &private_pem,
            device_id,
            &receipts,
            managed,
            &stop,
            UpgradeRuntimeOptions {
                key_path: &key,
                on_connected: Some(Arc::new(move || {
                    // Missing/invalid intent never becomes a success receipt.
                    let _ = write_upgrade_proof(&proof_key, &proof_id, &proof_exe);
                })),
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

#[cfg(target_os = "linux")]
fn main() {
    if linux::run().is_err() {
        eprintln!(r#"{{"service":"remote-control-agent","event":"startup_unavailable"}}"#);
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("Unshipped Standard Linux Agent is Linux-only.");
    std::process::exit(1);
}
