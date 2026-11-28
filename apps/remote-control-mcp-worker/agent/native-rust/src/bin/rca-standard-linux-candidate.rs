//! Standard Linux RCA entrypoint.
//! Shares the existing owner-reviewed permanent and temporary v2 identities.
#[cfg(target_os = "linux")]
#[path = "support/unix_pairing.rs"]
mod unix_pairing;

#[cfg(target_os = "linux")]
mod linux {
    use super::unix_pairing::{
        exists_owned_path, pair_identity_at, pair_or_repair, read_private, sidecar,
    };
    #[cfg(test)]
    use super::unix_pairing::{repair_identity, write_new};
    use rca_native_agent::automatic_update::{automatic_jitter, AutomaticCheckSchedule};
    use rca_native_agent::identity::{signed_session_proof, valid_device_id};
    use rca_native_agent::linux_managed::LinuxManagedSessions;
    use rca_native_agent::native_file::{
        run_native_managed_session_with_upgrade, NativeFileError, UpgradeRuntimeOptions,
    };
    use rca_native_agent::session::SessionError;
    use std::ffi::{CStr, OsStr};
    use std::fs;
    use std::io::{ErrorKind, Write};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    static SIGNAL_STOP: AtomicBool = AtomicBool::new(false);
    extern "C" fn request_stop(_: libc::c_int) {
        SIGNAL_STOP.store(true, Ordering::Release);
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

    // Resolve the UID 0 account through NSS, not the inherited environment.
    fn root_account_home() -> Result<PathBuf, ()> {
        let suggested = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
        let mut buffer = vec![
            0u8;
            usize::try_from(suggested)
                .ok()
                .filter(|&size| size > 0)
                .unwrap_or(16 * 1024)
        ];
        let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        let status = unsafe {
            libc::getpwuid_r(
                0,
                record.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status != 0 || result.is_null() {
            return Err(());
        }
        // NSS owns no output storage here: all strings remain valid in buffer
        // until copied to an owned path.
        let record = unsafe { record.assume_init() };
        if record.pw_uid != 0 || record.pw_dir.is_null() {
            return Err(());
        }
        let bytes = unsafe { CStr::from_ptr(record.pw_dir) }.to_bytes();
        Ok(PathBuf::from(OsStr::from_bytes(bytes)))
    }

    fn validate_root_home_path(
        home: &Path,
        account: &Path,
        metadata: impl Fn(&Path) -> Result<(u32, u32), ()>,
    ) -> Result<(), ()> {
        if !home.is_absolute() || home.as_os_str() != account.as_os_str() {
            return Err(());
        }
        for path in home.ancestors() {
            let (uid, mode) = metadata(path)?;
            if uid != 0
                || mode & libc::S_IFMT != libc::S_IFDIR
                || mode & 0o022 != 0
                || (path == home && mode & 0o077 != 0)
            {
                return Err(());
            }
        }
        Ok(())
    }

    fn home() -> Result<PathBuf, ()> {
        let root = PathBuf::from(std::env::var_os("HOME").ok_or(())?);
        if !root.is_absolute() {
            return Err(());
        }
        if unsafe { libc::geteuid() } == 0 {
            validate_root_home_path(&root, &root_account_home()?, |path| {
                let info = fs::symlink_metadata(path).map_err(|_| ())?;
                Ok((info.uid(), info.mode()))
            })?;
            if std::env::var("XDG_RUNTIME_DIR").is_ok_and(|value| value != "/run/user/0")
                || std::env::var("DBUS_SESSION_BUS_ADDRESS")
                    .is_ok_and(|value| value != "unix:path=/run/user/0/bus")
            {
                return Err(());
            }
        }
        Ok(root)
    }

    fn validate_root_mode(args: &mut Vec<String>, effective_uid: u32) -> Result<(), ()> {
        let requested = args.first().is_some_and(|value| value == "--root-managed");
        if requested {
            args.remove(0);
        }
        if (effective_uid == 0) != requested {
            return Err(());
        }
        Ok(())
    }

    fn key_path(home: &Path) -> Result<PathBuf, ()> {
        if let Some(explicit) = std::env::var_os("REMOTE_CONTROL_AGENT_KEY_PATH") {
            let path = PathBuf::from(explicit);
            return path.is_absolute().then_some(path).ok_or(());
        }
        Ok(home.join(".local/share/mcp-workers/remote-control/v2-identity.pem"))
    }

    fn installed_endpoint(home: &Path) -> Result<String, ()> {
        let directory = home.join(".config/systemd/user");
        if fs::canonicalize(home).ok().as_deref() != Some(home)
            || fs::canonicalize(&directory).ok().as_deref() != Some(directory.as_path())
        {
            return Err(());
        }
        let unit = directory.join("remote-control-agent.service");
        private_regular(&unit, 16 * 1024)?;
        if fs::symlink_metadata(&unit).map_err(|_| ())?.nlink() != 1 {
            return Err(());
        }
        let contents = fs::read_to_string(unit).map_err(|_| ())?;
        if !contents
            .lines()
            .any(|line| line == "# Managed by Remote Control Agent installer.")
        {
            return Err(());
        }
        let endpoints: Vec<&str> = contents
            .lines()
            .filter_map(|line| line.strip_prefix("Environment=REMOTE_CONTROL_AGENT_ENDPOINT="))
            .collect();
        if endpoints.len() != 1 {
            return Err(());
        }
        let endpoint = endpoints[0];
        let parsed = url::Url::parse(endpoint).map_err(|_| ())?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(());
        }
        Ok(endpoint.to_owned())
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
            && !((fields.len() == 4
                || (fields.len() == 5
                    && fields
                        .get("initial_launcher")
                        .and_then(|v| v.as_str())
                        .is_some_and(|v| !v.is_empty())))
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
        // Resolve the installed native bundle layout.
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
            &rca_native_agent::linux_command::configured_shell(),
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

    // Publish the same owner-local command as the permanent installer, but
    // never replace an existing command or imply service activation.
    fn publish_temporary_launcher(home: &Path, exe: &Path) -> Result<(), ()> {
        use std::os::unix::fs::{symlink, DirBuilderExt};
        let root = exe.ancestors().nth(4).ok_or(())?;
        let programs = home.join(".local/share/mcp-workers/remote-control/programs");
        if root.parent() != Some(programs.as_path())
            || exe != root.join("apps/remote-control-agent/.build/rca-standard-linux-candidate")
        {
            return Err(());
        }
        let target = root.join("apps/remote-control-agent/scripts/rca.sh");
        private_regular(&target, 65536)?;
        if fs::symlink_metadata(&target).map_err(|_| ())?.mode() & 0o111 == 0 {
            return Err(());
        }
        for dir in target
            .parent()
            .ok_or(())?
            .ancestors()
            .take_while(|p| p.starts_with(home))
        {
            let info = fs::symlink_metadata(dir).map_err(|_| ())?;
            if !info.is_dir()
                || info.uid() != unsafe { libc::geteuid() }
                || info.mode() & 0o022 != 0
            {
                return Err(());
            }
        }
        let manifest = root.join("bundle.json");
        private_regular(&manifest, 65536)?;
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(manifest).map_err(|_| ())?).map_err(|_| ())?;
        if value["artifact_profile"] != "rust-native-only-v1"
            || value["agent_runtime"] != "rust-standard-linux-v1"
        {
            return Err(());
        }
        let bin = home.join(".local/bin");
        match fs::DirBuilder::new().mode(0o700).create(&bin) {
            Ok(()) => (),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => (),
            Err(_) => return Err(()),
        }
        let info = fs::symlink_metadata(&bin).map_err(|_| ())?;
        if !info.is_dir() || info.uid() != unsafe { libc::geteuid() } || info.mode() & 0o022 != 0 {
            return Err(());
        }
        match symlink(&target, bin.join("rca")) {
            Ok(()) => fs::File::open(&bin)
                .and_then(|f| f.sync_all())
                .map_err(|_| ())?,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => (),
            Err(_) => return Err(()),
        }
        Ok(())
    }

    // Bootstrap owns permanent service activation. Temporary mode runs the
    // same runtime in this terminal, retaining the existing installer lock.
    fn pair_local(
        endpoint: &str,
        name: &str,
        temporary: bool,
        permanent_repair: Option<(i32, bool)>,
    ) -> Result<(), ()> {
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
        let home = home()?;
        let mode = if temporary { "temporary" } else { "permanent" };
        let (key, _lock) = lock_pairing_store(
            &home,
            temporary,
            temporary || permanent_repair.is_some(),
            permanent_repair,
        )?;
        let resolve = |pem: &str, existing: Option<&str>| {
            client
                .pair(pem, existing, name, temporary, |pending| {
                    println!("{}", client.approval_instruction(pending, mode));
                })
                .map_err(|_| ())
        };
        if let Some((_, prepare)) = permanent_repair {
            let transitioning = exists_owned_path(&sidecar(&key, ".re-pair-transition"))?;
            if !transitioning
                && (!prepare || read_private(&sidecar(&key, ".device-id"), 128)?.is_none())
            {
                return Err(());
            }
            pair_or_repair(&key, &client, resolve, prepare)?;
        } else if temporary {
            pair_or_repair(&key, &client, resolve, false)?;
        } else {
            pair_identity_at(&key, resolve)?;
        }
        if temporary {
            if publish_temporary_launcher(&home, &std::env::current_exe().map_err(|_| ())?).is_err()
            {
                eprintln!("Short command not published; use the reviewed local manager path.");
            }
            println!("Starting temporary foreground Agent; the Worker enforces the original 24h grant. Terminal exit disconnects, not revokes.");
            return run_agent(endpoint, &home, &pairing_key(&home, true));
        }
        println!("Approved identity recovered; service has not been started.");
        Ok(())
    }

    fn pairing_key(home: &Path, temporary: bool) -> PathBuf {
        let base = home.join(".local/share/mcp-workers/remote-control");
        if temporary {
            base.join("temporary/v2-identity.pem")
        } else {
            base.join("v2-identity.pem")
        }
    }

    #[cfg(test)]
    fn pair_local_identity(
        home: &Path,
        temporary: bool,
        resolve: impl FnOnce(&str, Option<&str>) -> Result<String, ()>,
    ) -> Result<fs::File, ()> {
        let (key, lock) = lock_pairing_store(home, temporary, false, None)?;
        pair_identity_at(&key, resolve)?;
        Ok(lock)
    }

    fn inherited_installer_lock(fd: i32, lock_path: &Path) -> Result<fs::File, ()> {
        use std::os::fd::FromRawFd;
        if fd < 3 || unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
            return Err(());
        }
        let file = unsafe { fs::File::from_raw_fd(fd) };
        let actual = file.metadata().map_err(|_| ())?;
        let expected = fs::symlink_metadata(lock_path).map_err(|_| ())?;
        if !expected.is_file() || (actual.dev(), actual.ino()) != (expected.dev(), expected.ino()) {
            return Err(());
        }
        Ok(file)
    }

    fn validate_installer_lock(lock: &fs::File) -> Result<(), ()> {
        use std::os::fd::AsRawFd;
        let info = lock.metadata().map_err(|_| ())?;
        if !info.is_file()
            || info.uid() != unsafe { libc::geteuid() }
            || info.nlink() != 1
            || info.mode() & 0o777 != 0o600
            || unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
        {
            return Err(());
        }
        Ok(())
    }

    fn secure_input_local(request_id: &str) -> Result<(), ()> {
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(());
        }
        let home = home()?;
        let key = key_path(&home)?;
        if fs::canonicalize(&home).ok().as_deref() != Some(home.as_path())
            || fs::canonicalize(&key).ok().as_deref() != Some(key.as_path())
        {
            return Err(());
        }
        private_regular(&key, 8192)?;
        let id_path = sidecar(&key, ".device-id");
        private_regular(&id_path, 128)?;
        let pem = fs::read_to_string(&key).map_err(|_| ())?;
        let id = fs::read_to_string(id_path).map_err(|_| ())?;
        let id = id.trim();
        if !valid_device_id(id) || owner_stopped(&key)? {
            return Err(());
        }
        let endpoint = installed_endpoint(&home)?;
        rca_native_agent::secure_input_cli::run_secure_input_owner_flow(
            &endpoint, &pem, id, request_id,
        )
        .map_err(|_| ())
    }

    fn owner_intent_local(endpoint: &str, action: &str, fd: i32) -> Result<(), ()> {
        use rca_native_agent::device_pairing::PairingClient;
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal()
            || !std::io::stdout().is_terminal()
            || !matches!(action, "stop" | "resume")
        {
            return Err(());
        }
        let home = home()?;
        let key = pairing_key(&home, false);
        let base = key.parent().ok_or(())?;
        if fs::canonicalize(&home).ok().as_deref() != Some(home.as_path())
            || fs::canonicalize(base).ok().as_deref() != Some(base)
        {
            return Err(());
        }
        rca_native_agent::upgrade_control::verify_upgrade_directory(&key).map_err(|_| ())?;
        let lock = inherited_installer_lock(fd, &base.join("v2-installer.lock"))?;
        validate_installer_lock(&lock)?;
        if read_private(&sidecar(&key, ".owner-stopped"), 32)?.as_deref() != Some("stopped\n") {
            return Err(());
        }
        let pem = read_private(&key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        if !valid_device_id(id.trim()) {
            return Err(());
        }
        PairingClient::new(endpoint)
            .map_err(|_| ())?
            .owner_intent(&pem, id.trim(), action)
            .map_err(|_| ())
    }

    fn lock_pairing_store(
        home: &Path,
        temporary: bool,
        repair: bool,
        permanent_repair: Option<(i32, bool)>,
    ) -> Result<(PathBuf, fs::File), ()> {
        let permanent = pairing_key(home, false);
        let base = permanent.parent().ok_or(())?;
        let key = pairing_key(home, temporary);
        let directory = key.parent().ok_or(())?;
        if fs::canonicalize(home).ok().as_deref() != Some(home)
            || fs::canonicalize(base).ok().as_deref() != Some(base)
        {
            return Err(());
        }
        for path in base.ancestors().take_while(|p| p.starts_with(home)) {
            let info = fs::symlink_metadata(path).map_err(|_| ())?;
            if !info.is_dir()
                || info.uid() != unsafe { libc::geteuid() }
                || info.mode() & 0o022 != 0
            {
                return Err(());
            }
        }
        rca_native_agent::upgrade_control::verify_upgrade_directory(&permanent).map_err(|_| ())?;
        let lock_path = base.join("v2-installer.lock");
        let lock = if let Some((fd, _)) = permanent_repair {
            // The Python service controller retains this same open-file-description
            // lock across preparation, service stop and identity promotion.
            inherited_installer_lock(fd, &lock_path)?
        } else {
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(&lock_path)
                .map_err(|_| ())?
        };
        validate_installer_lock(&lock)?;
        // A permanent service may exist when selecting a temporary identity.
        // It may not share the exclusive receipt writer; the same runtime
        // still fails closed before connecting when receipts are occupied.
        if !temporary {
            for path in [
                home.join(".config/systemd/user/remote-control-agent.service"),
                home.join(".config/systemd/user/remote-control-v2-agent.service"),
            ] {
                if permanent_repair.is_some_and(|(_, prepare)| prepare)
                    && path.ends_with("remote-control-agent.service")
                {
                    continue; // Python verifies the exact owned service before preparing.
                }
                if !matches!(fs::symlink_metadata(path), Err(e) if e.kind() == ErrorKind::NotFound)
                {
                    return Err(());
                }
            }
        }
        // Never admit another identity lifecycle while a permanent switch
        // or first activation is unresolved, even in temporary mode.
        for path in [
            sidecar(&permanent, ".native-upgrade-intent"),
            sidecar(&permanent, ".native-upgrade-proof"),
            sidecar(&permanent, ".activation-pending"),
            sidecar(&key, ".owner-stopped"),
            sidecar(&key, ".native-upgrade-intent"),
            sidecar(&key, ".activation-pending"),
        ] {
            if !matches!(fs::symlink_metadata(path), Err(e) if e.kind() == ErrorKind::NotFound) {
                return Err(());
            }
        }
        if permanent_repair.is_none()
            && exists_owned_path(&sidecar(&permanent, ".re-pair-transition"))?
        {
            return Err(());
        }
        if !repair && [".re-pair-transition", ".re-pair-new", ".re-pair-new.device-id"].iter().any(
            |suffix| !matches!(fs::symlink_metadata(sidecar(&key, suffix)), Err(e) if e.kind() == ErrorKind::NotFound)
        ) {
            return Err(());
        }
        if temporary {
            use std::os::unix::fs::DirBuilderExt;
            match fs::DirBuilder::new().mode(0o700).create(directory) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                Err(_) => return Err(()),
            }
        }
        if fs::canonicalize(directory).ok().as_deref() != Some(directory) {
            return Err(());
        }
        rca_native_agent::upgrade_control::verify_upgrade_directory(&key).map_err(|_| ())?;
        Ok((key, lock))
    }

    pub fn run() -> Result<(), ()> {
        let mut args: Vec<String> = std::env::args().skip(1).collect();
        validate_root_mode(&mut args, unsafe { libc::geteuid() })?;
        if unsafe { libc::geteuid() } == 0 {
            home()?;
        }
        if let [flag, command, request_id] = args.as_slice() {
            if flag == "--cli" && command == "secure-input" {
                return secure_input_local(request_id);
            }
        }
        if let [command, endpoint, name] = args.as_slice() {
            match command.as_str() {
                "--pair-local" => return pair_local(endpoint, name, false, None),
                "--temporary-local" => return pair_local(endpoint, name, true, None),
                _ => return Err(()),
            }
        }
        if let [command, endpoint, name, fd] = args.as_slice() {
            if command == "--owner-intent" {
                return owner_intent_local(endpoint, name, fd.parse().map_err(|_| ())?);
            }
            let prepare = match command.as_str() {
                "--prepare-permanent-repair" => true,
                "--promote-permanent-repair" => false,
                _ => return Err(()),
            };
            return pair_local(
                endpoint,
                name,
                false,
                Some((fd.parse().map_err(|_| ())?, prepare)),
            );
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
        run_agent(&endpoint, &home, &key)
    }

    fn automatic_manager(home: &Path, key: &Path, executable: &Path) -> Option<PathBuf> {
        if unsafe { libc::geteuid() } == 0 || key != pairing_key(home, false) {
            return None;
        }
        let app = executable.parent()?.parent()?;
        let root = app.parent()?.parent()?;
        if root.parent()? != home.join(".local/share/mcp-workers/remote-control/programs") {
            return None;
        }
        let manager = app.join("scripts/manage-v2.py");
        private_regular(&manager, 1024 * 1024).ok()?;
        Some(manager)
    }

    fn run_agent(endpoint: &str, home: &Path, key: &Path) -> Result<(), ()> {
        private_regular(key, 8192)?;
        private_regular(&sidecar(key, ".device-id"), 128)?;
        if owner_stopped(key)? {
            eprintln!(r#"{{"service":"remote-control-agent","event":"owner_stopped"}}"#);
            return Ok(());
        }
        let device_id = fs::read_to_string(sidecar(key, ".device-id")).map_err(|_| ())?;
        let device_id = device_id.trim();
        if !valid_device_id(device_id) {
            return Err(());
        }
        let private_pem = fs::read_to_string(key).map_err(|_| ())?;
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
        let proof_exe = std::env::current_exe().map_err(|_| ())?;
        let automatic_manager = automatic_manager(home, key, &proof_exe);
        let monitor = std::thread::spawn(move || {
            let mut schedule = automatic_manager
                .as_ref()
                .map(|_| AutomaticCheckSchedule::new(Instant::now(), automatic_jitter(240)));
            let mut checker: Option<std::process::Child> = None;
            while !watch_stop.load(Ordering::Acquire) {
                if SIGNAL_STOP.load(Ordering::Acquire) {
                    watch_stop.store(true, Ordering::Release);
                    break;
                }
                if let Some(child) = checker.as_mut() {
                    match child.try_wait() {
                        Ok(None) => (),
                        Ok(Some(_)) => checker = None,
                        Err(_) => {
                            // A failed observation must not cause an immediate replay.
                            checker = None;
                            eprintln!(
                                r#"{{"service":"remote-control-agent","event":"automatic_check_unconfirmed"}}"#
                            );
                        }
                    }
                }
                if let (Some(manager), Some(schedule)) =
                    (automatic_manager.as_ref(), schedule.as_mut())
                {
                    let now = Instant::now();
                    if checker.is_none()
                        && schedule.is_due(now)
                        && schedule.take_due(now, automatic_jitter(1800))
                    {
                        // Manager revalidates the installed permanent identity,
                        // consent, signed connection and pending transactions.
                        // Never block the Agent signal or execution loop on I/O.
                        match std::process::Command::new("/usr/bin/python3")
                            .args(["-I", "-B"])
                            .arg(manager)
                            .args(["update", "--automatic"])
                            .stdin(std::process::Stdio::null())
                            .spawn()
                        {
                            Ok(child) => checker = Some(child),
                            Err(_) => eprintln!(
                                r#"{{"service":"remote-control-agent","event":"automatic_check_launch_failed"}}"#
                            ),
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        // Exactly the existing Node default receipt location; never create a
        // parallel receipt ledger when switching the runtime.
        let proof_key = key.to_owned();
        let proof_id = device_id.to_owned();
        let proof_endpoint = endpoint.to_owned();
        let result = run_native_managed_session_with_upgrade(
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
                on_connected: Some(Arc::new(move || {
                    // Missing/invalid intent never becomes a success receipt.
                    let _ = write_upgrade_proof(&proof_key, &proof_id, &proof_exe, &proof_endpoint);
                })),
            },
        );
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
    mod pairing_tests {
        use super::*;
        const ID: &str = "123e4567-e89b-42d3-a456-426614174001";

        #[test]
        fn root_mode_requires_the_explicit_managed_entry_flag() {
            let mut root_args = vec!["--root-managed".to_owned(), "--cli".to_owned()];
            validate_root_mode(&mut root_args, 0).unwrap();
            assert_eq!(root_args, vec!["--cli"]);

            let mut missing = vec!["--cli".to_owned()];
            assert!(validate_root_mode(&mut missing, 0).is_err());

            let mut forged = vec!["--root-managed".to_owned()];
            assert!(validate_root_mode(&mut forged, 1001).is_err());

            let mut ordinary = vec!["--cli".to_owned()];
            validate_root_mode(&mut ordinary, 1001).unwrap();
        }

        #[test]
        fn root_home_requires_account_match_and_trusted_ancestors() {
            // Synthetic metadata only; no privileged identity or service.
            let home = Path::new("/srv/root");
            let check = |account: &Path, altered: Option<(&Path, u32, u32)>| {
                validate_root_home_path(home, account, |path| {
                    if let Some((bad, uid, mode)) = altered {
                        if path == bad {
                            return Ok((uid, mode));
                        }
                    }
                    Ok((0, libc::S_IFDIR | if path == home { 0o700 } else { 0o755 }))
                })
            };
            assert!(check(home, None).is_ok());
            assert!(check(Path::new("/root"), None).is_err());
            assert!(check(home, Some((Path::new("/srv"), 1001, libc::S_IFDIR | 0o755))).is_err());
            assert!(check(home, Some((Path::new("/srv"), 0, libc::S_IFDIR | 0o775))).is_err());
            assert!(check(home, Some((Path::new("/srv"), 0, libc::S_IFLNK | 0o777))).is_err());
            assert!(check(home, Some((home, 0, libc::S_IFDIR | 0o550))).is_err());
        }

        #[test]
        fn temporary_launcher_is_owner_local_and_never_replaces_existing_command() {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path();
            let root = home
                .join(".local/share/mcp-workers/remote-control/programs/v0.1.57-linux-x64-glibc");
            let exe = root.join("apps/remote-control-agent/.build/rca-standard-linux-candidate");
            let target = root.join("apps/remote-control-agent/scripts/rca.sh");
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            write_new(&target, b"#!/bin/sh\n").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
            write_new(&root.join("bundle.json"), br#"{"artifact_profile":"rust-native-only-v1","agent_runtime":"rust-standard-linux-v1"}"#).unwrap();
            publish_temporary_launcher(home, &exe).unwrap();
            let launcher = home.join(".local/bin/rca");
            assert_eq!(fs::read_link(&launcher).unwrap(), target);
            fs::remove_file(&launcher).unwrap();
            write_new(&launcher, b"foreign").unwrap();
            publish_temporary_launcher(home, &exe).unwrap();
            assert_eq!(fs::read(&launcher).unwrap(), b"foreign");
        }

        #[test]
        fn permanent_repair_prepares_without_moving_and_keeps_parent_lock() {
            use std::os::fd::AsRawFd;
            let root = tempfile::tempdir().unwrap();
            let key = pairing_key(root.path(), false);
            let base = key.parent().unwrap();
            fs::create_dir_all(base).unwrap();
            fs::set_permissions(base, fs::Permissions::from_mode(0o700)).unwrap();
            let parent_lock =
                pair_local_identity(root.path(), false, |_, _| Ok(ID.to_owned())).unwrap();
            let old = fs::read(&key).unwrap();
            let unit = root
                .path()
                .join(".config/systemd/user/remote-control-agent.service");
            fs::create_dir_all(unit.parent().unwrap()).unwrap();
            fs::write(&unit, b"existing service").unwrap();
            let dup = || unsafe { libc::dup(parent_lock.as_raw_fd()) };
            let (_, child_lock) =
                lock_pairing_store(root.path(), false, true, Some((dup(), true))).unwrap();
            let next = "123e4567-e89b-42d3-a456-426614174002";
            repair_identity(
                &key,
                true,
                |_, id| {
                    assert_eq!(id, ID);
                    Ok(())
                },
                |_, _| Ok(next.to_owned()),
                |_, id| {
                    assert_eq!(id, next);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(fs::read(&key).unwrap(), old);
            assert_eq!(
                fs::read_to_string(sidecar(&key, ".device-id"))
                    .unwrap()
                    .trim(),
                ID
            );
            assert!(sidecar(&key, ".re-pair-transition").exists());
            drop(child_lock);
            assert!(
                pair_local_identity(root.path(), true, |_, _| panic!("parent lock bypassed"))
                    .is_err()
            );
            assert!(lock_pairing_store(root.path(), false, true, Some((dup(), false))).is_err());
            fs::remove_file(unit).unwrap();
            let (_, _child_lock) =
                lock_pairing_store(root.path(), false, true, Some((dup(), false))).unwrap();
            repair_identity(
                &key,
                false,
                |_, id| {
                    assert_eq!(id, ID);
                    Ok(())
                },
                |_, _| panic!("prepared replacement must be retained"),
                |_, id| {
                    assert_eq!(id, next);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(
                fs::read_to_string(sidecar(&key, ".device-id"))
                    .unwrap()
                    .trim(),
                next
            );
            assert!(!sidecar(&key, ".re-pair-transition").exists());
        }

        #[test]
        fn temporary_identity_is_separate_and_holds_the_shared_installer_lock() {
            let root = tempfile::tempdir().unwrap();
            let permanent = pairing_key(root.path(), false);
            let temporary = pairing_key(root.path(), true);
            let base = permanent.parent().unwrap();
            fs::create_dir_all(base).unwrap();
            fs::set_permissions(base, fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(&permanent, b"permanent-key-must-not-be-read-or-changed").unwrap();
            let unit = root
                .path()
                .join(".config/systemd/user/remote-control-agent.service");
            fs::create_dir_all(unit.parent().unwrap()).unwrap();
            fs::write(&unit, b"existing unit").unwrap();
            let lock = pair_local_identity(root.path(), true, |pem, existing| {
                assert!(existing.is_none());
                assert_ne!(pem, "permanent-key-must-not-be-read-or-changed");
                Ok(ID.to_owned())
            })
            .unwrap();
            assert_eq!(
                fs::read_to_string(sidecar(&temporary, ".device-id"))
                    .unwrap()
                    .trim(),
                ID
            );
            assert_eq!(fs::metadata(&temporary).unwrap().mode() & 0o777, 0o600);
            assert!(
                pair_local_identity(root.path(), true, |_, _| panic!("lock bypassed")).is_err()
            );
            drop(lock);
            assert!(pair_local_identity(root.path(), false, |_, _| panic!(
                "permanent unit bypassed"
            ))
            .is_err());
            let pem = fs::read(&temporary).unwrap();
            pair_local_identity(root.path(), true, |same, existing| {
                assert_eq!(same.as_bytes(), pem);
                assert_eq!(existing, Some(ID));
                Ok(ID.to_owned())
            })
            .unwrap();
            assert_eq!(
                fs::read(&permanent).unwrap(),
                b"permanent-key-must-not-be-read-or-changed"
            );
            assert_eq!(fs::read(&unit).unwrap(), b"existing unit");
            fs::write(sidecar(&permanent, ".native-upgrade-intent"), b"unresolved").unwrap();
            assert!(pair_local_identity(root.path(), true, |_, _| panic!(
                "upgrade conflict bypassed"
            ))
            .is_err());
        }

        #[test]
        fn pending_key_survives_failure_and_signed_identity_is_not_replaced() {
            let root = tempfile::tempdir().unwrap();
            fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let store = root.path().join(".local/share/mcp-workers/remote-control");
            fs::create_dir_all(&store).unwrap();
            fs::set_permissions(&store, fs::Permissions::from_mode(0o700)).unwrap();
            let key = store.join("v2-identity.pem");
            let id = sidecar(&key, ".device-id");
            assert!(pair_local_identity(root.path(), false, |_, existing| {
                assert!(existing.is_none());
                Err(())
            })
            .is_err());
            let original = fs::read_to_string(&key).unwrap();
            assert!(!id.exists());
            assert_eq!(fs::metadata(&key).unwrap().mode() & 0o777, 0o600);
            pair_local_identity(root.path(), false, |pem, existing| {
                assert_eq!(pem, original);
                assert!(existing.is_none());
                Ok(ID.to_owned())
            })
            .unwrap();
            assert_eq!(fs::read_to_string(&id).unwrap().trim(), ID);
            assert_eq!(fs::metadata(&id).unwrap().mode() & 0o777, 0o600);
            assert!(pair_local_identity(root.path(), false, |pem, existing| {
                assert_eq!(pem, original);
                assert_eq!(existing, Some(ID));
                Ok("123e4567-e89b-42d3-a456-426614174002".to_owned())
            })
            .is_err());
            assert_eq!(fs::read_to_string(&key).unwrap(), original);
            assert_eq!(fs::read_to_string(&id).unwrap().trim(), ID);
            fs::remove_file(&key).unwrap();
            assert!(
                pair_local_identity(root.path(), false, |_, _| panic!("orphan ID admitted"))
                    .is_err()
            );
            assert!(!key.exists());
            std::os::unix::fs::symlink(&id, &key).unwrap();
            assert!(
                pair_local_identity(root.path(), false, |_, _| panic!("linked key admitted"))
                    .is_err()
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
    eprintln!("Standard RCA requires Linux.");
    std::process::exit(1);
}
