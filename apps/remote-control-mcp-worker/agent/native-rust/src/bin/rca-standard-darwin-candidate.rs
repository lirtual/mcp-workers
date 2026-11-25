//! Unshipped Standard macOS RCA entrypoint. No installed Agent path uses it.
//! Reuses the permanent and temporary identity storage of the reviewed Unix Agent.
#[cfg(target_os = "macos")]
#[path = "support/unix_pairing.rs"]
mod unix_pairing;

#[cfg(any(target_os = "macos", all(test, unix)))]
fn pairing_store(
    home: &std::path::Path,
    temporary: bool,
) -> Result<(std::path::PathBuf, std::fs::File), ()> {
    use std::fs;
    use std::io::ErrorKind;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};

    let owner = unsafe { libc::geteuid() };
    let home = fs::canonicalize(home).map_err(|_| ())?;
    let present = |p: &std::path::Path| match fs::symlink_metadata(p) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(()),
    };
    let check_dir = |p: &std::path::Path, private: bool| {
        let info = fs::symlink_metadata(p).map_err(|_| ())?;
        if !info.is_dir()
            || info.uid() != owner
            || info.mode() & (if private { 0o077 } else { 0o022 }) != 0
        {
            return Err(());
        }
        Ok(())
    };
    let ensure_dir = |p: &std::path::Path, private: bool| {
        match fs::DirBuilder::new().mode(0o700).create(p) {
            Ok(()) => (),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => (),
            Err(_) => return Err(()),
        }
        check_dir(p, private)
    };
    check_dir(&home, false)?;
    let mut base = home.clone();
    for (index, part) in [".local", "share", "mcp-workers", "remote-control"]
        .iter()
        .enumerate()
    {
        base.push(part);
        ensure_dir(&base, index >= 2)?;
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(base.join("v2-installer.lock"))
        .map_err(|_| ())?;
    let info = lock.metadata().map_err(|_| ())?;
    if !info.is_file()
        || info.uid() != owner
        || info.nlink() != 1
        || info.mode() & 0o777 != 0o600
        || unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
    {
        return Err(());
    }
    // Reuse the existing Mac journal and Linux installer lock contract. Do
    // not pair while an earlier management transaction remains unresolved.
    let macos = base.join("macos");
    if present(&macos)? {
        check_dir(&macos, true)?;
    }
    for path in [
        macos.join("switch.json"),
        macos.join("remote-upgrades/active.json"),
    ] {
        if present(&path)? {
            return Err(());
        }
    }
    // The permanent pairing transaction must be allowed to resume itself;
    // temporary pairing must not cross that unresolved identity boundary.
    if temporary && present(&base.join("v2-identity.pem.re-pair-transition"))? {
        return Err(());
    }
    if !temporary
        && present(&home.join("Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist"))?
    {
        return Err(());
    }
    let directory = if temporary {
        let directory = base.join("temporary");
        ensure_dir(&directory, true)?;
        directory
    } else {
        base
    };
    Ok((directory.join("v2-identity.pem"), lock))
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn owner_stopped(key: &std::path::Path) -> Result<bool, ()> {
    use std::fs;
    use std::io::{ErrorKind, Read};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    // The macOS manager already owns this durable OFF state. The service
    // must not introduce a different marker or restart a deliberately stopped
    // device, including when cloud Stop could not be confirmed.
    let directory = key.parent().ok_or(())?.join("macos");
    let owner = unsafe { libc::geteuid() };
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Ok(info)
            if info.is_dir() && info.uid() == owner && info.permissions().mode() & 0o077 == 0 => {}
        _ => return Err(()),
    }
    let marker = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory.join("stopped"))
    {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Ok(file) => file,
        Err(_) => return Err(()),
    };
    let info = marker.metadata().map_err(|_| ())?;
    if !info.is_file()
        || info.nlink() != 1
        || info.uid() != owner
        || info.permissions().mode() & 0o777 != 0o600
        || info.len() != 8
    {
        return Err(());
    }
    let mut value = Vec::new();
    marker.take(9).read_to_end(&mut value).map_err(|_| ())?;
    if value != b"stopped\n" {
        return Err(());
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
mod darwin {
    use super::unix_pairing::{pair_or_repair, read_private, sidecar};
    use super::{owner_stopped, pairing_store};
    use rca_native_agent::darwin_managed::DarwinManagedSessions;
    use rca_native_agent::identity::{signed_session_proof, valid_device_id};
    use rca_native_agent::native_file::{
        run_native_managed_session, run_native_managed_session_with_upgrade, NativeFileError,
        UpgradeRuntimeOptions,
    };
    use rca_native_agent::session::{HeartbeatTiming, SessionError};
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

    fn native_host() -> Result<(), ()> {
        use std::ffi::CStr;
        let mut info = unsafe { std::mem::zeroed::<libc::utsname>() };
        if unsafe { libc::geteuid() } == 0 || unsafe { libc::uname(&mut info) } != 0 {
            return Err(());
        }
        let release = unsafe { CStr::from_ptr(info.release.as_ptr()) }
            .to_str()
            .map_err(|_| ())?;
        if release
            .split('.')
            .next()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0)
            < 24
        {
            return Err(());
        }
        #[cfg(target_arch = "x86_64")]
        {
            let mut arm64: libc::c_int = 0;
            let mut size = std::mem::size_of_val(&arm64);
            let status = unsafe {
                libc::sysctlbyname(
                    c"hw.optional.arm64".as_ptr(),
                    (&mut arm64 as *mut libc::c_int).cast(),
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                )
            };
            if status == 0 && (arm64 != 0 || size != std::mem::size_of_val(&arm64)) {
                return Err(());
            }
            if status != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) {
                return Err(());
            }
        }
        Ok(())
    }

    fn service_absent() -> Result<(), ()> {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::time::Instant;
        let target = format!("gui/{}/org.mcp-workers.remote-control-agent", unsafe {
            libc::geteuid()
        });
        let mut child = Command::new("/bin/launchctl")
            .args(["print", &target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| ())?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut stderr = String::new();
                    child
                        .stderr
                        .take()
                        .ok_or(())?
                        .take(8192)
                        .read_to_string(&mut stderr)
                        .map_err(|_| ())?;
                    return (status.code() == Some(113)
                        && stderr.contains("Could not find service"))
                    .then_some(())
                    .ok_or(());
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(());
                }
            }
        }
    }

    fn pair_local(endpoint: &str, name: &str, temporary: bool) -> Result<(), ()> {
        use rca_native_agent::device_pairing::PairingClient;
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal()
            || !std::io::stdout().is_terminal()
            || name.is_empty()
            || name.encode_utf16().count() > 64
            || name.chars().any(|c| c < '\u{20}')
        {
            return Err(());
        }
        let url = url::Url::parse(endpoint).map_err(|_| ())?;
        if url.port_or_known_default() != Some(443) {
            return Err(());
        }
        let client = PairingClient::new(endpoint).map_err(|_| ())?;
        let _supervisor = checked_supervisor()?;
        let home = home()?;
        unsafe {
            libc::umask(0o077);
        }
        let (key, _lock) = pairing_store(&home, temporary)?;
        if !temporary {
            service_absent()?;
            if owner_stopped(&key)? {
                return Err(());
            }
        }
        let mode = if temporary { "temporary" } else { "permanent" };
        pair_or_repair(
            &key,
            &client,
            |pem, existing| {
                let id = client
                    .pair(pem, existing, name, temporary, |pending| {
                        println!("{}", client.approval_instruction(pending, mode));
                    })
                    .map_err(|_| ())?;
                if !temporary {
                    client.verify_permanent_grant(&id).map_err(|_| ())?;
                }
                Ok(id)
            },
            false,
        )?;
        if temporary {
            println!("Starting temporary foreground Agent; the Worker enforces the original 24h grant. Terminal exit disconnects, not revokes.");
            return run_agent(endpoint, &home, &key, None);
        }
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        client.verify_permanent_grant(id.trim()).map_err(|_| ())?;
        println!("Approved identity recovered; service has not been started.");
        Ok(())
    }

    pub fn run() -> Result<(), ()> {
        native_host()?;
        let arguments: Vec<String> = std::env::args_os()
            .skip(1)
            .map(|value| value.into_string().map_err(|_| ()))
            .collect::<Result<_, _>>()?;
        if let [action, endpoint, name] = arguments.as_slice() {
            return match action.as_str() {
                "--pair-local" => pair_local(endpoint, name, false),
                "--temporary-local" => pair_local(endpoint, name, true),
                _ => Err(()),
            };
        }
        if arguments.len() != 5
            || arguments[0] != "--service"
            || arguments[1] != "--endpoint"
            || arguments[3] != "--generation"
            || !valid_device_id(&arguments[4])
        {
            return Err(());
        }
        let home = home()?;
        let key = key_path(&home)?;
        run_agent(&arguments[2], &home, &key, Some(&arguments[4]))
    }

    fn run_agent(
        endpoint: &str,
        home: &Path,
        key: &Path,
        generation: Option<&str>,
    ) -> Result<(), ()> {
        if generation.is_some() && owner_stopped(key)? {
            eprintln!(r#"{{"service":"remote-control-agent","event":"owner_stopped"}}"#);
            return Ok(());
        }
        let device_id = read_private(&sidecar(key, ".device-id"), 128)?.ok_or(())?;
        let device_id = device_id.trim();
        if !valid_device_id(device_id) {
            return Err(());
        }
        let private_pem = read_private(key, 8192)?.ok_or(())?;
        // Local PEM validation before any receipt ownership or network I/O.
        signed_session_proof(&private_pem, device_id, "ABCDEFGHIJKLMNOPQRSTUVWX")
            .map_err(|_| ())?;
        let managed = checked_supervisor()?;
        // Fail closed before creating Node's existing SQLite receipt directory.
        rca_native_agent::upgrade_control::verify_upgrade_directory(key).map_err(|_| ())?;
        unsafe {
            libc::umask(0o077);
        }
        let receipts = standard_receipts(home)?;
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
        let result = if let Some(generation) = generation {
            let marker_identity = key.parent().ok_or(())?.to_path_buf();
            let marker_generation = generation.to_owned();
            let on_connected: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                let _ = record_connected(&marker_identity, &marker_generation);
            });
            run_native_managed_session_with_upgrade(
                endpoint,
                &private_pem,
                device_id,
                &receipts,
                managed,
                &stop,
                UpgradeRuntimeOptions {
                    on_disconnected: None,
                    on_diagnostic: None,
                    key_path: key,
                    on_connected: Some(on_connected),
                },
            )
        } else {
            // A temporary identity has no persistent service or upgrade IPC.
            run_native_managed_session(
                endpoint,
                &private_pem,
                device_id,
                &receipts,
                managed,
                &stop,
                HeartbeatTiming::default(),
            )
        };
        stop.store(true, Ordering::Release);
        monitor.join().map_err(|_| ())?;
        if let Err(error) = &result {
            if !matches!(error, NativeFileError::Session(_)) {
                rca_native_agent::session::report_diagnostic(error.diagnostic_event());
            }
        }
        match result {
            Ok(()) | Err(NativeFileError::Session(SessionError::Policy)) => Ok(()),
            Err(_) => Err(()),
        }
    }
    #[cfg(test)]
    mod connection_marker_tests {
        use super::*;

        #[test]
        fn rust_connection_marker_is_owner_private_json_with_a_newline() {
            let dir = tempfile::tempdir().unwrap();
            // The installed Node identity is owner-private. macOS test tmp
            // directories do not necessarily inherit that mode.
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let info = fs::symlink_metadata(dir.path()).unwrap();
            assert_eq!(info.uid(), unsafe { libc::geteuid() });
            assert_eq!(info.permissions().mode() & 0o077, 0);
            let marker = dir.path().join("macos-connection.json");
            record_connected(dir.path(), "candidate-generation").unwrap();
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

#[cfg(all(test, unix))]
mod owner_stop_tests {
    use super::owner_stopped;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn macos_service_honors_the_manager_stop_marker() {
        let root = tempfile::tempdir().unwrap();
        let key = root.path().join("v2-identity.pem");
        let macos = root.path().join("macos");
        fs::create_dir(&macos).unwrap();
        fs::set_permissions(&macos, fs::Permissions::from_mode(0o700)).unwrap();
        let marker = macos.join("stopped");
        assert_eq!(owner_stopped(&key), Ok(false));

        fs::write(&marker, b"stopped\n").unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(owner_stopped(&key), Ok(true));
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(owner_stopped(&key).is_err());
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&marker, b"unknown\n").unwrap();
        assert!(owner_stopped(&key).is_err());
        fs::remove_file(&marker).unwrap();
        symlink("missing", &marker).unwrap();
        assert!(owner_stopped(&key).is_err());
        fs::remove_file(&marker).unwrap();
        fs::remove_dir(&macos).unwrap();
        symlink("missing", &macos).unwrap();
        assert!(owner_stopped(&key).is_err());
    }
}

#[cfg(all(test, unix))]
mod pairing_admission_tests {
    use super::pairing_store;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn permanent_and_temporary_paths_are_separate_and_serialized() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        fs::set_permissions(home, fs::Permissions::from_mode(0o700)).unwrap();
        let (permanent, lock) = pairing_store(home, false).unwrap();
        fs::write(&permanent, b"synthetic-permanent").unwrap();
        assert!(pairing_store(home, true).is_err());
        drop(lock);
        let (temporary, lock) = pairing_store(home, true).unwrap();
        assert_eq!(
            temporary.parent().unwrap(),
            permanent.parent().unwrap().join("temporary")
        );
        assert_eq!(fs::read(&permanent).unwrap(), b"synthetic-permanent");
        assert!(!temporary.exists());
        assert!(pairing_store(home, false).is_err());
        drop(lock);
        let macos = permanent.parent().unwrap().join("macos");
        fs::create_dir(&macos).unwrap();
        fs::set_permissions(&macos, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(macos.join("switch.json"), b"unresolved").unwrap();
        assert!(pairing_store(home, true).is_err());
        assert!(pairing_store(home, false).is_err());
        fs::remove_file(macos.join("switch.json")).unwrap();
        let transition = permanent
            .parent()
            .unwrap()
            .join("v2-identity.pem.re-pair-transition");
        fs::write(&transition, b"resume").unwrap();
        assert!(pairing_store(home, true).is_err());
        assert!(pairing_store(home, false).is_ok());
        fs::remove_file(transition).unwrap();
        let agents = home.join("Library/LaunchAgents");
        fs::create_dir_all(&agents).unwrap();
        fs::write(
            agents.join("org.mcp-workers.remote-control-agent.plist"),
            b"existing",
        )
        .unwrap();
        assert!(pairing_store(home, false).is_err());
        assert!(pairing_store(home, true).is_ok());
    }

    #[test]
    fn redirected_pairing_path_is_denied() {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        symlink("missing", dir.path().join(".local")).unwrap();
        assert!(pairing_store(dir.path(), true).is_err());
    }
}
