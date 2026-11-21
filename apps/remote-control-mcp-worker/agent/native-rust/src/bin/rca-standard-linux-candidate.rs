//! Unshipped Standard Linux RCA entrypoint. No installed Agent path uses it.
//! The only supported state input is an existing owner-paired Node v2 identity.
#[cfg(target_os = "linux")]
mod linux {
    use rca_native_agent::identity::{signed_session_proof, valid_device_id};
    use rca_native_agent::linux_managed::LinuxManagedSessions;
    use rca_native_agent::native_file::{run_native_managed_session_with_upgrade, NativeFileError};
    use rca_native_agent::session::SessionError;
    use std::ffi::OsStr;
    use std::fs;
    use std::io::ErrorKind;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
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
        let result = run_native_managed_session_with_upgrade(
            &endpoint,
            &private_pem,
            device_id,
            &receipts,
            managed,
            &stop,
            &key,
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
