//! Unshipped Unix process tracer for #914; never use a paired production identity.
//! Only an owner-private disposable root and exact localhost Wrangler are accepted.
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix {
    #[cfg(target_os = "macos")]
    use rca_native_agent::darwin_managed::DarwinManagedSessions as ManagedSessions;
    use rca_native_agent::identity::valid_device_id;
    #[cfg(target_os = "linux")]
    use rca_native_agent::linux_managed::LinuxManagedSessions as ManagedSessions;
    use rca_native_agent::native_file::{
        run_native_file_session, run_native_managed_session, NativeFileError,
    };
    use rca_native_agent::session::{HeartbeatTiming, SessionError};
    use std::fs;
    use std::io::ErrorKind;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    const LOCAL_WORKER: &str = "http://127.0.0.1:8777/";
    #[cfg(target_os = "linux")]
    const HELPER_ENV: &str = "RCA_NATIVE_SUPERVISOR_BIN";
    #[cfg(target_os = "macos")]
    const HELPER_ENV: &str = "RCA_DARWIN_SUPERVISOR_BIN";
    static SIGNAL_STOP: AtomicBool = AtomicBool::new(false);

    extern "C" fn request_stop(_: libc::c_int) {
        SIGNAL_STOP.store(true, Ordering::Release);
    }

    fn private_disposable_root(root: &Path) -> bool {
        let Ok(metadata) = fs::symlink_metadata(root) else {
            return false;
        };
        let Ok(canonical_tmp) = fs::canonicalize("/tmp") else {
            return false;
        };
        root.is_absolute()
            && root.parent() == Some(canonical_tmp.as_path())
            && root
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rca-rust-probe-"))
            && metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.permissions().mode() & 0o077 == 0
            && fs::canonicalize(root).ok().as_deref() == Some(root)
    }

    fn owner_stopped(key: &Path) -> Result<bool, &'static str> {
        let marker = key.with_file_name("gate0-test-key.pem.owner-stopped");
        match fs::symlink_metadata(marker) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(_) => Err("owner STOP marker cannot be inspected"),
            Ok(meta)
                if meta.is_file()
                    && !meta.file_type().is_symlink()
                    && meta.nlink() == 1
                    && meta.uid() == unsafe { libc::geteuid() }
                    && meta.permissions().mode() & 0o777 == 0o600 =>
            {
                Ok(true)
            }
            Ok(_) => Err("unsafe owner STOP marker"),
        }
    }

    fn read_disposable_identity(key: &Path) -> Result<String, &'static str> {
        let meta = fs::symlink_metadata(key).map_err(|_| "missing test identity")?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.nlink() != 1
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.permissions().mode() & 0o077 != 0
            || meta.len() == 0
            || meta.len() > 8_192
        {
            return Err("test identity must be private and regular");
        }
        fs::read_to_string(key).map_err(|_| "test identity is unreadable")
    }

    fn explicit_local_supervisor() -> Result<Arc<ManagedSessions>, &'static str> {
        let value = std::env::var_os(HELPER_ENV)
            .ok_or("nonproduction managed mode requires an explicit C supervisor")?;
        let path = Path::new(&value);
        let meta = fs::symlink_metadata(path).map_err(|_| "nonproduction C supervisor missing")?;
        if !path.is_absolute()
            || !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.permissions().mode() & 0o022 != 0
            || meta.permissions().mode() & 0o6000 != 0
            || meta.permissions().mode() & 0o111 == 0
            || fs::canonicalize(path).ok().as_deref() != Some(path)
        {
            return Err("untrusted nonproduction C supervisor");
        }
        ManagedSessions::new(path, Path::new("/bin/sh"), Duration::from_secs(60 * 60))
            .map(Arc::new)
            .map_err(|_| "invalid nonproduction managed configuration")
    }

    fn install_stop_signals() -> Result<(), &'static str> {
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
                return Err("unable to install stop handlers");
            }
        }
        Ok(())
    }

    pub fn run() -> Result<(), &'static str> {
        // Root support is a distinct Gate 2 contract (#912), not an implicit fallback.
        if unsafe { libc::geteuid() } == 0 {
            return Err("root candidate requires the separate #912 gate");
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        let [mode, device_id, root] = args.as_slice() else {
            return Err(
                "usage: rca-native-nonprod (--local|--local-managed) DEVICE_UUID DISPOSABLE_ROOT",
            );
        };
        if !matches!(mode.as_str(), "--local" | "--local-managed") || !valid_device_id(device_id) {
            return Err("only explicit local modes and a disposable device UUID are accepted");
        }
        let root = Path::new(root);
        if !private_disposable_root(root) {
            return Err("untrusted disposable root");
        }
        let key = root.join("gate0-test-key.pem");
        if owner_stopped(&key)? {
            eprintln!("owner_stopped; no connection attempted");
            return Ok(());
        }
        let private_pem = read_disposable_identity(&key)?;
        // Managed commands remain opt-in and Linux-only. Installed state
        // paths are rejected; callers must use separately approved test keys.
        let managed_mode = mode == "--local-managed";
        let managed = if managed_mode {
            Some(explicit_local_supervisor()?)
        } else {
            None
        };
        // The process cannot be reached via public Worker URLs or normal
        // installed Agent state. Existing host OS permissions still apply.
        unsafe {
            libc::umask(0o077);
        }
        install_stop_signals()?;
        let stop = Arc::new(AtomicBool::new(false));
        let monitor_stop = Arc::clone(&stop);
        let monitor = std::thread::spawn(move || {
            while !monitor_stop.load(Ordering::Acquire) {
                if SIGNAL_STOP.load(Ordering::Acquire) {
                    monitor_stop.store(true, Ordering::Release);
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });

        let outcome = if let Some(managed) = managed {
            run_native_managed_session(
                LOCAL_WORKER,
                &private_pem,
                device_id,
                &root.join("receipts"),
                managed,
                &stop,
                HeartbeatTiming::default(),
            )
        } else {
            run_native_file_session(
                LOCAL_WORKER,
                &private_pem,
                device_id,
                &root.join("receipts"),
                &stop,
                HeartbeatTiming::default(),
            )
        };
        stop.store(true, Ordering::Release);
        monitor.join().map_err(|_| "stop monitor failed")?;
        // Match the Node service contract: a confirmed 1008/policy shutdown
        // exits cleanly to avoid a service-manager restart hammer. Unknown
        // cleanup or any other runtime/receipt failure still exits nonzero.
        match outcome {
            Ok(()) => Ok(()),
            Err(NativeFileError::Session(SessionError::Policy)) if managed_mode => Ok(()),
            Err(_) => Err("nonproduction signed session failed"),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn main() {
    if let Err(message) = unix::run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn main() {
    eprintln!("nonproduction native process requires Unix");
    std::process::exit(1);
}
