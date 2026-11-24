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
    fn write_upgrade_proof(
        key: &Path,
        device_id: &str,
        executable: &Path,
        endpoint: &str,
    ) -> Result<(), ()> {
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
        if fields.len() != 3
            && !(fields.len() == 4
                && fields.get("initial_endpoint").and_then(|v| v.as_str()) == Some(endpoint))
        {
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

    // First pairing only. Bootstrap owns activation; this entry never
    // starts a service or changes an approved/revoked device's key.
    fn pair_local(endpoint: &str, name: &str) -> Result<(), ()> {
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
        let client = PairingClient::new(endpoint).map_err(|_| ())?;
        let _supervisor = checked_supervisor()?;
        pair_local_identity(&home()?, |pem, existing| {
            client.pair(pem, existing, name, false, |pending| {
                println!("Pairing code (10 min): {}", pending.code);
                println!("Local public key fingerprint: {}", pending.fingerprint);
                println!("Use MCP pairing_lookup, then explicitly pairing_approve for the exact key and permanent mode.");
            }).map_err(|_| ())
        })?;
        println!("Approved identity recovered; service has not been started.");
        Ok(())
    }

    fn pair_local_identity(
        home: &Path,
        resolve: impl FnOnce(&str, Option<&str>) -> Result<String, ()>,
    ) -> Result<(), ()> {
        use rca_native_agent::device_pairing::generate_private_pem;
        use std::io::Read;
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        let key = home.join(".local/share/mcp-workers/remote-control/v2-identity.pem");
        let directory = key.parent().ok_or(())?;
        if fs::canonicalize(home).ok().as_deref() != Some(home)
            || fs::canonicalize(directory).ok().as_deref() != Some(directory)
        {
            return Err(());
        }
        for path in directory.ancestors().take_while(|p| p.starts_with(home)) {
            let info = fs::symlink_metadata(path).map_err(|_| ())?;
            if !info.is_dir()
                || info.uid() != unsafe { libc::geteuid() }
                || info.mode() & 0o022 != 0
            {
                return Err(());
            }
        }
        rca_native_agent::upgrade_control::verify_upgrade_directory(&key).map_err(|_| ())?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(directory.join("v2-installer.lock"))
            .map_err(|_| ())?;
        let info = lock.metadata().map_err(|_| ())?;
        if !info.is_file()
            || info.uid() != unsafe { libc::geteuid() }
            || info.nlink() != 1
            || info.mode() & 0o777 != 0o600
            || unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
        {
            return Err(());
        }
        for path in [
            home.join(".config/systemd/user/remote-control-agent.service"),
            home.join(".config/systemd/user/remote-control-v2-agent.service"),
            sidecar(&key, ".owner-stopped"),
            sidecar(&key, ".re-pair-transition"),
            sidecar(&key, ".re-pair-new"),
            sidecar(&key, ".native-upgrade-intent"),
            sidecar(&key, ".activation-pending"),
        ] {
            if !matches!(fs::symlink_metadata(path), Err(e) if e.kind() == ErrorKind::NotFound) {
                return Err(());
            }
        }
        let read_private = |path: &Path, limit: u64| -> Result<Option<String>, ()> {
            let file = match fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)
            {
                Ok(file) => file,
                Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(()),
            };
            let info = file.metadata().map_err(|_| ())?;
            if !info.is_file()
                || info.uid() != unsafe { libc::geteuid() }
                || info.nlink() != 1
                || info.mode() & 0o777 != 0o600
                || info.len() == 0
                || info.len() > limit
            {
                return Err(());
            }
            let mut value = String::new();
            file.take(limit + 1)
                .read_to_string(&mut value)
                .map_err(|_| ())?;
            if value.len() as u64 != info.len() {
                return Err(());
            }
            Ok(Some(value))
        };
        let write_new = |path: &Path, bytes: &[u8]| -> Result<(), ()> {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| ())?;
            let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
            let temp = directory.join(format!(".pair-{suffix}.tmp"));
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)
                .map_err(|_| ())?;
            let result = (|| {
                file.write_all(bytes).map_err(|_| ())?;
                file.sync_all().map_err(|_| ())?;
                let src = std::ffi::CString::new(temp.as_os_str().as_bytes()).map_err(|_| ())?;
                let dst = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| ())?;
                // Standard requires Linux 6.9+, so atomic no-replace is
                // available without a second identity journal or link race.
                if unsafe {
                    libc::renameat2(
                        libc::AT_FDCWD,
                        src.as_ptr(),
                        libc::AT_FDCWD,
                        dst.as_ptr(),
                        libc::RENAME_NOREPLACE,
                    )
                } != 0
                {
                    return Err(());
                }
                fs::File::open(directory)
                    .and_then(|f| f.sync_all())
                    .map_err(|_| ())
            })();
            if result.is_err() && temp.exists() {
                let _ = fs::remove_file(&temp);
            }
            result
        };
        let id_path = sidecar(&key, ".device-id");
        let existing = read_private(&id_path, 128)?;
        if existing
            .as_ref()
            .is_some_and(|id| !valid_device_id(id.trim()))
        {
            return Err(());
        }
        let pem = match read_private(&key, 8192)? {
            Some(pem) => pem,
            None if existing.is_none() => {
                let pem = generate_private_pem().map_err(|_| ())?;
                write_new(&key, pem.as_bytes())?;
                pem
            }
            None => return Err(()),
        };
        let id = resolve(&pem, existing.as_deref().map(str::trim))?;
        if !valid_device_id(&id) || existing.as_ref().is_some_and(|old| old.trim() != id) {
            return Err(());
        }
        if existing.is_none() {
            write_new(&id_path, format!("{id}\n").as_bytes())?;
        }
        Ok(())
    }

    pub fn run() -> Result<(), ()> {
        if unsafe { libc::geteuid() } == 0 {
            return Err(());
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        if let [command, endpoint, name] = args.as_slice() {
            if command == "--pair-local" {
                return pair_local(endpoint, name);
            }
        }
        if !args.is_empty() {
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
        let proof_endpoint = endpoint.clone();
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
                    let _ = write_upgrade_proof(&proof_key, &proof_id, &proof_exe, &proof_endpoint);
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
    #[cfg(test)]
    mod pairing_tests {
        use super::*;
        const ID: &str = "123e4567-e89b-42d3-a456-426614174001";

        #[test]
        fn pending_key_survives_failure_and_signed_identity_is_not_replaced() {
            let root = tempfile::tempdir().unwrap();
            fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let store = root.path().join(".local/share/mcp-workers/remote-control");
            fs::create_dir_all(&store).unwrap();
            fs::set_permissions(&store, fs::Permissions::from_mode(0o700)).unwrap();
            let key = store.join("v2-identity.pem");
            let id = sidecar(&key, ".device-id");
            assert!(pair_local_identity(root.path(), |_, existing| {
                assert!(existing.is_none());
                Err(())
            })
            .is_err());
            let original = fs::read_to_string(&key).unwrap();
            assert!(!id.exists());
            assert_eq!(fs::metadata(&key).unwrap().mode() & 0o777, 0o600);
            pair_local_identity(root.path(), |pem, existing| {
                assert_eq!(pem, original);
                assert!(existing.is_none());
                Ok(ID.to_owned())
            })
            .unwrap();
            assert_eq!(fs::read_to_string(&id).unwrap().trim(), ID);
            assert_eq!(fs::metadata(&id).unwrap().mode() & 0o777, 0o600);
            assert!(pair_local_identity(root.path(), |pem, existing| {
                assert_eq!(pem, original);
                assert_eq!(existing, Some(ID));
                Ok("123e4567-e89b-42d3-a456-426614174002".to_owned())
            })
            .is_err());
            assert_eq!(fs::read_to_string(&key).unwrap(), original);
            assert_eq!(fs::read_to_string(&id).unwrap().trim(), ID);
            fs::remove_file(&key).unwrap();
            assert!(pair_local_identity(root.path(), |_, _| panic!("orphan ID admitted")).is_err());
            assert!(!key.exists());
            std::os::unix::fs::symlink(&id, &key).unwrap();
            assert!(
                pair_local_identity(root.path(), |_, _| panic!("linked key admitted")).is_err()
            );
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
