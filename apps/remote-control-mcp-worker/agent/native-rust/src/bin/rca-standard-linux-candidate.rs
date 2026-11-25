//! Unshipped Standard Linux RCA entrypoint. No installed Agent path uses it.
//! Shares the existing owner-reviewed permanent and temporary v2 identities.
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

    fn pair_identity_at(
        key: &Path,
        resolve: impl FnOnce(&str, Option<&str>) -> Result<String, ()>,
    ) -> Result<String, ()> {
        use rca_native_agent::device_pairing::generate_private_pem;
        let id_path = sidecar(key, ".device-id");
        let existing = read_private(&id_path, 128)?;
        if existing
            .as_ref()
            .is_some_and(|id| !valid_device_id(id.trim()))
        {
            return Err(());
        }
        let pem = match read_private(key, 8192)? {
            Some(pem) => pem,
            None if existing.is_none() => {
                let pem = generate_private_pem().map_err(|_| ())?;
                write_new(key, pem.as_bytes())?;
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
        Ok(id)
    }

    fn read_private(path: &Path, limit: u64) -> Result<Option<String>, ()> {
        use std::io::Read;
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
    }

    fn write_new(path: &Path, bytes: &[u8]) -> Result<(), ()> {
        let directory = path.parent().ok_or(())?;
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
            move_identity_file(&temp, path)
        })();
        if result.is_err() && temp.exists() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    fn exists_owned_path(path: &Path) -> Result<bool, ()> {
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
            Err(_) => Err(()),
        }
    }

    fn move_identity_file(from: &Path, to: &Path) -> Result<(), ()> {
        use std::os::unix::ffi::OsStrExt;
        let src = std::ffi::CString::new(from.as_os_str().as_bytes()).map_err(|_| ())?;
        let dst = std::ffi::CString::new(to.as_os_str().as_bytes()).map_err(|_| ())?;
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
        for dir in [from.parent().ok_or(())?, to.parent().ok_or(())?] {
            fs::File::open(dir)
                .and_then(|f| f.sync_all())
                .map_err(|_| ())?;
        }
        Ok(())
    }

    fn pair_or_repair(
        key: &Path,
        client: &rca_native_agent::device_pairing::PairingClient,
        resolve: impl Fn(&str, Option<&str>) -> Result<String, ()>,
        prepare_only: bool,
    ) -> Result<(), ()> {
        if !exists_owned_path(&sidecar(key, ".re-pair-transition"))?
            && !exists_owned_path(&sidecar(key, ".re-pair-new"))?
            && !exists_owned_path(&sidecar(key, ".re-pair-new.device-id"))?
        {
            if let Some(id) = read_private(&sidecar(key, ".device-id"), 128)? {
                let pem = read_private(key, 8192)?.ok_or(())?;
                let id = id.trim();
                if !valid_device_id(id) {
                    return Err(());
                }
                match client.recover(&pem, Some(id)) {
                    Ok(_) => return Ok(()),
                    Err(rca_native_agent::session_recovery::SessionRecoveryError::Denied) => (),
                    Err(_) => return Err(()),
                }
            } else {
                return pair_identity_at(key, &resolve).map(|_| ());
            }
        }
        // An explicit denial alone never authorizes replacing a key. The
        // independent signed negative-status response is mandatory.
        repair_identity(
            key,
            prepare_only,
            |pem, id| client.assert_revoked(pem, id).map_err(|_| ()),
            &resolve,
            |pem, id| client.recover(pem, Some(id)).map(|_| ()).map_err(|_| ()),
        )
    }

    // Call only under the existing installer lock, and with no process
    // using this identity. Reuse the original Node five-prefix transaction
    // and archive naming. No extra journal or credential format.
    fn repair_identity(
        key: &Path,
        prepare_only: bool,
        revoked: impl Fn(&str, &str) -> Result<(), ()>,
        pair: impl FnOnce(&str, Option<&str>) -> Result<String, ()>,
        approved: impl Fn(&str, &str) -> Result<(), ()>,
    ) -> Result<(), ()> {
        use serde_json::{json, Value};
        use std::os::unix::fs::DirBuilderExt;
        let parent = key.parent().ok_or(())?;
        let marker = sidecar(key, ".re-pair-transition");
        let id_path = sidecar(key, ".device-id");
        let stage = sidecar(key, ".re-pair-new");
        let stage_id = sidecar(&stage, ".device-id");
        let record: Value = if let Some(data) = read_private(&marker, 512)? {
            serde_json::from_str(&data).map_err(|_| ())?
        } else {
            let old = read_private(&id_path, 128)?.ok_or(())?;
            let old = old.trim();
            if !valid_device_id(old) {
                return Err(());
            }
            let pem = read_private(key, 8192)?.ok_or(())?;
            revoked(&pem, old)?;
            println!("Old identity is no longer approved; a replacement requires independent owner approval.");
            let next = pair_identity_at(&stage, pair)?;
            if next == old {
                return Err(());
            }
            let record = json!({"version":1,"old_id":old,"new_id":next});
            // As in the Node installer: after owner approval, before any
            // identity move. Every subsequent prefix can be resumed.
            write_new(&marker, format!("{record}\n").as_bytes())?;
            record
        };
        let fields = record.as_object().ok_or(())?;
        let old = fields.get("old_id").and_then(Value::as_str).ok_or(())?;
        let next = fields.get("new_id").and_then(Value::as_str).ok_or(())?;
        if fields.len() != 3
            || fields.get("version").and_then(Value::as_u64) != Some(1)
            || !valid_device_id(old)
            || !valid_device_id(next)
            || old == next
        {
            return Err(());
        }
        let archive = parent.join(format!("revoked-{old}"));
        let archived = archive.join("identity.pem");
        let archived_id = sidecar(&archived, ".device-id");
        let files = [
            key,
            id_path.as_path(),
            stage.as_path(),
            stage_id.as_path(),
            archived.as_path(),
            archived_id.as_path(),
        ];
        let present: Vec<bool> = files
            .iter()
            .map(|p| exists_owned_path(p))
            .collect::<Result<_, _>>()?;
        let phases = [
            [true, true, true, true, false, false],
            [false, true, true, true, true, false],
            [false, false, true, true, true, true],
            [true, false, false, true, true, true],
            [true, true, false, false, true, true],
        ];
        let phase = phases
            .iter()
            .position(|shape| shape.as_slice() == present.as_slice())
            .ok_or(())?;
        if exists_owned_path(&archive)? {
            rca_native_agent::upgrade_control::verify_upgrade_directory(&archived)
                .map_err(|_| ())?;
            if fs::metadata(&archive).map_err(|_| ())?.mode() & 0o777 != 0o700
                || fs::canonicalize(&archive).ok().as_deref() != Some(archive.as_path())
            {
                return Err(());
            }
            // No unexpected archive entries, even on a resumed promotion.
            let expected = if phase == 0 {
                0
            } else if phase == 1 {
                1
            } else {
                2
            };
            if fs::read_dir(&archive).map_err(|_| ())?.count() != expected {
                return Err(());
            }
        } else if phase != 0 {
            return Err(());
        }
        let old_key = if phase == 0 { key } else { &archived };
        let old_id_file = if phase < 2 { &id_path } else { &archived_id };
        let new_key = if phase < 3 { &stage } else { key };
        let new_id_file = if phase < 4 { &stage_id } else { &id_path };
        let old_pem = read_private(old_key, 8192)?.ok_or(())?;
        let new_pem = read_private(new_key, 8192)?.ok_or(())?;
        if read_private(old_id_file, 128)?.ok_or(())?.trim() != old
            || read_private(new_id_file, 128)?.ok_or(())?.trim() != next
        {
            return Err(());
        }
        revoked(&old_pem, old)?;
        approved(&new_pem, next)?;
        if prepare_only {
            return Ok(());
        }
        if !exists_owned_path(&archive)? {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&archive)
                .map_err(|_| ())?;
            fs::File::open(parent)
                .and_then(|f| f.sync_all())
                .map_err(|_| ())?;
        }
        let steps = [
            (key, archived.as_path()),
            (id_path.as_path(), archived_id.as_path()),
            (stage.as_path(), key),
            (stage_id.as_path(), id_path.as_path()),
        ];
        for (from, to) in steps.iter().skip(phase) {
            move_identity_file(from, to)?;
        }
        // The previous service must be absent before permanent promotion.
        // On interruption, the ordinary installer recovers the same approved
        // replacement and establishes a separate signed activation intent.
        fs::remove_file(marker).map_err(|_| ())?;
        fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|_| ())?;
        println!("Previous identity archived; approved replacement retained.");
        Ok(())
    }

    pub fn run() -> Result<(), ()> {
        if unsafe { libc::geteuid() } == 0 {
            return Err(());
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
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
        let proof_key = key.to_owned();
        let proof_id = device_id.to_owned();
        let proof_exe = std::env::current_exe().map_err(|_| ())?;
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

        const NEW_ID: &str = "123e4567-e89b-42d3-a456-426614174002";

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
        fn revoked_promotion_resumes_each_original_node_rename_prefix() {
            use std::os::unix::fs::DirBuilderExt;
            for prefix in 0..=4 {
                let dir = tempfile::tempdir().unwrap();
                let key = dir.path().join("v2-identity.pem");
                let id = sidecar(&key, ".device-id");
                let stage = sidecar(&key, ".re-pair-new");
                let stage_id = sidecar(&stage, ".device-id");
                let marker = sidecar(&key, ".re-pair-transition");
                let archive = dir.path().join(format!("revoked-{ID}"));
                let archived = archive.join("identity.pem");
                let archived_id = sidecar(&archived, ".device-id");
                fs::DirBuilder::new().mode(0o700).create(&archive).unwrap();
                // Independent fixture for each durable Node transaction prefix.
                let old_key_path = if prefix > 0 { &archived } else { &key };
                let old_id_path = if prefix > 1 { &archived_id } else { &id };
                let new_key_path = if prefix > 2 { &key } else { &stage };
                let new_id_path = if prefix > 3 { &id } else { &stage_id };
                write_new(old_key_path, b"old-pem").unwrap();
                write_new(old_id_path, ID.as_bytes()).unwrap();
                write_new(new_key_path, b"new-pem").unwrap();
                write_new(new_id_path, NEW_ID.as_bytes()).unwrap();
                write_new(
                    &marker,
                    format!(r#"{{"version":1,"old_id":"{ID}","new_id":"{NEW_ID}"}}"#).as_bytes(),
                )
                .unwrap();
                repair_identity(
                    &key,
                    false,
                    |pem, device| {
                        assert_eq!((pem, device), ("old-pem", ID));
                        Ok(())
                    },
                    |_, _| panic!("resumed promotion must not request another grant"),
                    |pem, device| {
                        assert_eq!((pem, device), ("new-pem", NEW_ID));
                        Ok(())
                    },
                )
                .unwrap();
                assert_eq!(fs::read(&key).unwrap(), b"new-pem");
                assert_eq!(fs::read_to_string(&id).unwrap(), NEW_ID);
                assert_eq!(fs::read(&archived).unwrap(), b"old-pem");
                assert_eq!(fs::read_to_string(&archived_id).unwrap(), ID);
                assert!(!marker.exists() && !stage.exists() && !stage_id.exists());
            }
        }

        #[test]
        fn revoked_promotion_requires_both_remote_checks_and_preserves_old_key() {
            let dir = tempfile::tempdir().unwrap();
            let key = dir.path().join("v2-identity.pem");
            let id = sidecar(&key, ".device-id");
            let stage = sidecar(&key, ".re-pair-new");
            let marker = sidecar(&key, ".re-pair-transition");
            write_new(&key, b"old-pem").unwrap();
            write_new(&id, ID.as_bytes()).unwrap();
            assert!(repair_identity(
                &key,
                false,
                |_, _| Err(()),
                |_, _| panic!("unverified revoke"),
                |_, _| panic!("not paired")
            )
            .is_err());
            assert!(!marker.exists() && !stage.exists());
            assert!(repair_identity(
                &key,
                false,
                |_, _| Ok(()),
                |_, _| Err(()),
                |_, _| panic!("not approved")
            )
            .is_err());
            assert!(stage.exists() && !marker.exists());
            let staged = fs::read_to_string(&stage).unwrap();
            assert!(repair_identity(
                &key,
                false,
                |_, _| Ok(()),
                |pem, existing| {
                    assert_eq!(pem, staged);
                    assert!(existing.is_none());
                    Ok(NEW_ID.to_owned())
                },
                |_, _| Err(())
            )
            .is_err());
            assert!(marker.exists());
            assert_eq!(fs::read(&key).unwrap(), b"old-pem");
            assert_eq!(fs::read_to_string(&id).unwrap(), ID);
            // Foreign archive contents must never be overwritten.
            let archive = dir.path().join(format!("revoked-{ID}"));
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&archive).unwrap();
            write_new(&archive.join("unrelated"), b"preserve").unwrap();
            assert!(repair_identity(
                &key,
                false,
                |_, _| Ok(()),
                |_, _| panic!("already paired"),
                |_, _| Ok(())
            )
            .is_err());
            assert_eq!(fs::read(archive.join("unrelated")).unwrap(), b"preserve");
            assert_eq!(fs::read(&key).unwrap(), b"old-pem");
            assert!(marker.exists());
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
    eprintln!("Unshipped Standard Linux Agent is Linux-only.");
    std::process::exit(1);
}
