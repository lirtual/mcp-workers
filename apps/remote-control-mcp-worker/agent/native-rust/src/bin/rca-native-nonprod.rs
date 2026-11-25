//! Unshipped disposable process tracer for #914; never use a paired production identity.
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
        root.is_absolute()
            && root.parent() == fs::canonicalize("/tmp").ok().as_deref()
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
        // Root is forbidden in this disposable CLI; Linux #912 is a separate gate.
        if unsafe { libc::geteuid() } == 0 {
            return Err("root is disabled for this nonproduction candidate");
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
        // Managed commands remain opt-in. Installed state paths are rejected;
        // callers must use separately approved test keys.
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

#[cfg(windows)]
mod windows {
    use rca_native_agent::identity::valid_device_id;
    use rca_native_agent::native_file::{
        run_native_file_session, run_native_managed_session, NativeFileError,
    };
    use rca_native_agent::session::{HeartbeatTiming, SessionError};
    use rca_native_agent::validate_windows_private_path;
    use rca_native_agent::windows_managed::WindowsManagedSessions;
    use std::fs::{self, File};
    use std::io::ErrorKind;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    };
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT,
    };

    const LOCAL_WORKER: &str = "http://127.0.0.1:8777/";
    static SIGNAL_STOP: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn request_stop(event: u32) -> i32 {
        if event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT {
            SIGNAL_STOP.store(true, Ordering::Release);
            return 1;
        }
        0
    }

    fn private_disposable_root(root: &Path) -> bool {
        let Ok(meta) = fs::symlink_metadata(root) else {
            return false;
        };
        let Ok(temp) = fs::canonicalize(std::env::temp_dir()) else {
            return false;
        };
        root.is_absolute()
            && root
                .parent()
                .and_then(|parent| fs::canonicalize(parent).ok())
                == Some(temp)
            && root
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rca-rust-probe-"))
            && meta.is_dir()
            && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
            && validate_windows_private_path(root, true).is_ok()
    }

    fn private_regular_file(path: &Path, allow_empty: bool) -> bool {
        let Ok(meta) = fs::symlink_metadata(path) else {
            return false;
        };
        if !meta.is_file()
            || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (!allow_empty && meta.len() == 0)
            || meta.len() > 8_192
            || validate_windows_private_path(path, false).is_err()
        {
            return false;
        }
        let Ok(file) = File::open(path) else {
            return false;
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        (unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) }) != 0
            && info.nNumberOfLinks == 1
            && info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
    }

    fn owner_stopped(key: &Path) -> Result<bool, &'static str> {
        let marker = key.with_file_name("gate0-test-key.pem.owner-stopped");
        match fs::symlink_metadata(&marker) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(_) => Err("owner STOP marker cannot be inspected"),
            Ok(_) if private_regular_file(&marker, true) => Ok(true),
            Ok(_) => Err("unsafe owner STOP marker"),
        }
    }

    fn read_disposable_identity(key: &Path) -> Result<String, &'static str> {
        if !private_regular_file(key, false) {
            return Err("test identity must be private and regular");
        }
        fs::read_to_string(key).map_err(|_| "test identity is unreadable")
    }

    pub fn run() -> Result<(), &'static str> {
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
        let managed_mode = mode == "--local-managed";
        let managed = if managed_mode {
            Some(Arc::new(
                WindowsManagedSessions::new(Duration::from_secs(60 * 60))
                    .map_err(|_| "invalid nonproduction Windows Job configuration")?,
            ))
        } else {
            None
        };

        if unsafe { SetConsoleCtrlHandler(Some(request_stop), 1) } == 0 {
            return Err("unable to install stop handlers");
        }
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
        match outcome {
            Ok(()) => Ok(()),
            Err(NativeFileError::Session(SessionError::Policy)) if managed_mode => Ok(()),
            Err(_) => Err("nonproduction signed session failed"),
        }
    }
}

#[cfg(windows)]
fn main() {
    if let Err(message) = windows::run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn main() {
    eprintln!("nonproduction native process is unsupported on this OS");
    std::process::exit(1);
}
