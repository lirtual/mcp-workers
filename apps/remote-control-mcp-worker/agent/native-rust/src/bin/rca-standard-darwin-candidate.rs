//! Unshipped Standard macOS RCA entrypoint. No installed Agent path uses it.
//! Reuses the permanent and temporary identity storage of the reviewed Unix Agent.
#[cfg(any(target_os = "macos", all(test, unix)))]
#[path = "support/darwin_lifecycle.rs"]
mod darwin_lifecycle;

#[cfg(any(target_os = "macos", all(test, unix)))]
#[path = "support/darwin_package.rs"]
mod darwin_package;

#[cfg(target_os = "macos")]
#[path = "support/unix_pairing.rs"]
mod unix_pairing;

#[cfg(any(target_os = "macos", all(test, unix)))]
fn directory_present(path: &std::path::Path, private: bool) -> Result<bool, ()> {
    use std::os::unix::fs::MetadataExt;
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Ok(info)
            if info.is_dir()
                && info.uid() == unsafe { libc::geteuid() }
                && info.mode() & (if private { 0o077 } else { 0o022 }) == 0 =>
        {
            Ok(true)
        }
        _ => Err(()),
    }
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn identity_directory(home: &std::path::Path, create: bool) -> Result<std::path::PathBuf, ()> {
    use std::fs;
    use std::io::ErrorKind;
    use std::os::unix::fs::DirBuilderExt;

    let home = fs::canonicalize(home).map_err(|_| ())?;
    let check_dir =
        |p: &std::path::Path, private: bool| directory_present(p, private)?.then_some(()).ok_or(());
    let ensure_dir = |p: &std::path::Path, private: bool| {
        if !create {
            return check_dir(p, private);
        }
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
    Ok(base)
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn lock_identity_directory(base: &std::path::Path) -> Result<std::fs::File, ()> {
    use std::fs;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let owner = unsafe { libc::geteuid() };
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
    Ok(lock)
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn pairing_store(
    home: &std::path::Path,
    temporary: bool,
) -> Result<(std::path::PathBuf, std::fs::File), ()> {
    use std::fs;
    use std::io::ErrorKind;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let base = identity_directory(home, true)?;
    let home = fs::canonicalize(home).map_err(|_| ())?;
    let lock = lock_identity_directory(&base)?;
    let present = |p: &std::path::Path| match fs::symlink_metadata(p) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(()),
    };
    let check_dir = |p: &std::path::Path| {
        let info = fs::symlink_metadata(p).map_err(|_| ())?;
        if !info.is_dir() || info.uid() != unsafe { libc::geteuid() } || info.mode() & 0o077 != 0 {
            return Err(());
        }
        Ok(())
    };
    // Reuse the existing Mac journal and Linux installer lock contract. Do
    // not pair while an earlier management transaction remains unresolved.
    let macos = base.join("macos");
    if present(&macos)? {
        check_dir(&macos)?;
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
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => (),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => (),
            Err(_) => return Err(()),
        }
        check_dir(&directory)?;
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

#[cfg(any(target_os = "macos", all(test, unix)))]
fn record_connection(
    identity: &std::path::Path,
    generation: &str,
    version: Option<&str>,
    connected: bool,
) -> Result<(), ()> {
    use std::fs;
    use std::io::{ErrorKind, Write};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
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
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| ())?;
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let temporary = identity.join(format!(".connection-{suffix}"));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ())?
        .as_millis();
    let record = serde_json::json!({
        "generation": generation,
        "version": version,
        "pid": std::process::id(),
        "state": if connected { "connected" } else { "disconnected" },
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
    if fs::rename(&temporary, &marker).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod darwin {
    use super::darwin_lifecycle::{
        apply_connection_observation, apply_policy_observation, connection_time,
        default_diagnostics, diagnostic_response, installed_generation, native_cli, native_plist,
        new_generation, no_other_programs, registration, resume_owned, stop_owned, switch_outcome,
        unregister_owned, Registration, RestartRecord, SwitchOutcome, SwitchRecord,
        UninstallRecord, UninstallRecovery, LABEL,
    };
    use super::darwin_package;
    use super::unix_pairing::{
        exists_owned_path, move_owned_exclusive, pair_or_repair, read_executable, read_private,
        replace_owned, sidecar, write_executable, write_new,
    };
    use super::{
        directory_present, identity_directory, lock_identity_directory, owner_stopped,
        pairing_store, record_connection,
    };
    use rca_native_agent::darwin_managed::DarwinManagedSessions;
    use rca_native_agent::identity::{signed_session_proof, valid_device_id};
    use rca_native_agent::native_file::{
        run_native_managed_session, run_native_managed_session_with_upgrade, NativeFileError,
        UpgradeRuntimeOptions,
    };
    use rca_native_agent::session::{HeartbeatTiming, SessionError};
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

    fn checked_supervisor() -> Result<Arc<DarwinManagedSessions>, ()> {
        // Candidate bundle layout only. The installed Node release is untouched.
        let helper = fs::canonicalize(std::env::current_exe().map_err(|_| ())?)
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

    // Drain both pipes while the bounded launchctl request runs.
    fn launchctl(args: &[&str]) -> Result<(Option<i32>, String, String), ()> {
        bounded_command("/bin/launchctl", args, 65536)
    }

    fn bounded_command(
        program: &str,
        args: &[&str],
        limit: u64,
    ) -> Result<(Option<i32>, String, String), ()> {
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::time::Instant;
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| ())?;
        let stdout = child.stdout.take().ok_or(())?;
        let stderr = child.stderr.take().ok_or(())?;
        fn collect(
            input: impl Read + Send + 'static,
            limit: u64,
        ) -> std::thread::JoinHandle<Result<String, ()>> {
            std::thread::spawn(move || {
                let mut data = Vec::new();
                input
                    .take(limit + 1)
                    .read_to_end(&mut data)
                    .map_err(|_| ())?;
                if data.len() as u64 > limit {
                    return Err(());
                }
                String::from_utf8(data).map_err(|_| ())
            })
        }
        let out = collect(stdout, limit);
        let err = collect(stderr, limit);
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status.code()),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(());
                }
            }
        };
        Ok((
            status?,
            out.join().map_err(|_| ())??,
            err.join().map_err(|_| ())??,
        ))
    }

    fn service_target() -> String {
        format!("gui/{}/{LABEL}", unsafe { libc::geteuid() })
    }

    fn service_absent() -> Result<(), ()> {
        let (code, out, err) = launchctl(&["print", &service_target()])?;
        (registration(code, &out, &err, Path::new("/")) == Registration::Absent)
            .then_some(())
            .ok_or(())
    }

    fn observe_registration(executable: &Path) -> Registration {
        match launchctl(&["print", &service_target()]) {
            Ok((code, out, err)) => registration(code, &out, &err, executable),
            Err(_) => Registration::Unknown,
        }
    }

    struct Installed {
        executable: PathBuf,
        endpoint: String,
        version: String,
        generation: String,
        plist: PathBuf,
    }

    fn owner_directory(parent: &Path, name: &str, private: bool) -> Result<PathBuf, ()> {
        let path = parent.join(name);
        directory_present(&path, private)?.then_some(path).ok_or(())
    }

    fn program_directory(base: &Path) -> Result<PathBuf, ()> {
        owner_directory(&owner_directory(base, "macos", true)?, "programs", true)
    }

    fn startup_paths(home: &Path) -> Result<(PathBuf, PathBuf), ()> {
        let home = fs::canonicalize(home).map_err(|_| ())?;
        let agents = owner_directory(
            &owner_directory(&home, "Library", false)?,
            "LaunchAgents",
            false,
        )?;
        let bin = owner_directory(&owner_directory(&home, ".local", false)?, "bin", false)?;
        Ok((agents.join(format!("{LABEL}.plist")), bin.join("rca")))
    }

    // Resolve the previous service from the exact canonical plist rather
    // than treating the newly downloaded executable as the installed one.
    fn resolve_installation(
        programs: &Path,
        plist: &Path,
        raw: &str,
        endpoint: &str,
    ) -> Result<Installed, ()> {
        let mut found = None;
        for entry in fs::read_dir(programs).map_err(|_| ())? {
            let entry = entry.map_err(|_| ())?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let suffix = format!("-{}", native_target());
            let Some(version) = name.strip_suffix(&suffix) else {
                continue;
            };
            if !darwin_package::valid_version(version) {
                continue;
            }
            let executable = entry.path().join(darwin_package::ENTRY);
            let Ok(generation) = installed_generation(raw, &executable, endpoint) else {
                continue;
            };
            if found.is_some() {
                return Err(());
            }
            let package = darwin_package::verify(&entry.path(), native_target())?;
            if package.version != version {
                return Err(());
            }
            found = Some(Installed {
                executable,
                endpoint: endpoint.to_owned(),
                version: version.to_owned(),
                generation,
                plist: plist.to_owned(),
            });
        }
        found.ok_or(())
    }

    fn installed(home: &Path, base: &Path) -> Result<Installed, ()> {
        let programs = program_directory(base)?;
        let (plist, cli) = startup_paths(home)?;
        let endpoint = read_private(&base.join("macos/endpoint"), 2048)?.ok_or(())?;
        let raw = read_private(&plist, 65536)?.ok_or(())?;
        let current = resolve_installation(&programs, &plist, &raw, endpoint.trim())?;
        if current.executable != current_bundle()?.join(darwin_package::ENTRY)
            || read_executable(&cli)?.as_deref() != Some(native_cli(&current.executable)?.as_str())
        {
            return Err(());
        }
        Ok(current)
    }

    fn now_ms() -> Result<u64, ()> {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| ())?
            .as_millis()
            .try_into()
            .map_err(|_| ())
    }

    // Return only marker evidence tied to this registered process, then
    // confirm current signed WSS through the existing read-only IPC gate.
    fn connection_evidence(current: &Installed, key: &Path, pid: u32) -> Option<(bool, u64, bool)> {
        let file = key.parent()?.join("macos-connection.json");
        let raw = read_private(&file, 1024).ok()??;
        let (connected, at) = connection_time(
            &raw,
            &current.generation,
            &current.version,
            pid,
            now_ms().ok()?,
        )?;
        let online = connected
            && rca_native_agent::upgrade_control::verify_online(key).is_ok_and(|value| value)
            && observe_registration(&current.executable) == Registration::Present(Some(pid))
            && read_private(&file, 1024).ok().flatten().as_deref() == Some(raw.as_str());
        Some((connected, at, online))
    }

    fn await_online(current: &Installed, key: &Path, after: u64) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        for _ in 0..50 {
            if std::time::Instant::now() >= deadline {
                break;
            }
            if let Registration::Present(Some(pid)) = observe_registration(&current.executable) {
                if connection_evidence(current, key, pid)
                    .is_some_and(|(_, at, online)| online && at >= after)
                {
                    return true;
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        false
    }

    fn diagnostic_state() -> Result<serde_json::Value, ()> {
        let home = fs::canonicalize(home()?).map_err(|_| ())?;
        if !directory_present(&home, false)? {
            return Err(());
        }
        // Stop at the first missing ancestor; do not traverse an unchecked
        // directory, create directories, or acquire a writable lifecycle lock.
        let path = |parts: &[(&str, bool)]| -> Result<Option<PathBuf>, ()> {
            let mut current = home.clone();
            for (name, private) in parts {
                current.push(name);
                if !directory_present(&current, *private)? {
                    return Ok(None);
                }
            }
            Ok(Some(current))
        };
        let base = path(&[
            (".local", false),
            ("share", false),
            ("mcp-workers", true),
            ("remote-control", true),
        ])?;
        let agents = path(&[("Library", false), ("LaunchAgents", false)])?;
        let bin = path(&[(".local", false), ("bin", false)])?;
        let configured = agents
            .map(|p| exists_owned_path(&p.join(format!("{LABEL}.plist"))))
            .transpose()?
            .unwrap_or(false);
        let launcher = bin
            .map(|p| exists_owned_path(&p.join("rca")))
            .transpose()?
            .unwrap_or(false);
        let mut state = default_diagnostics(if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        });
        if let Some(base) = &base {
            let key = base.join("v2-identity.pem");
            match (
                read_private(&key, 8192),
                read_private(&sidecar(&key, ".device-id"), 128),
            ) {
                (Ok(Some(pem)), Ok(Some(id)))
                    if valid_device_id(id.trim())
                        && signed_session_proof(&pem, id.trim(), "ABCDEFGHIJKLMNOPQRSTUVWX")
                            .is_ok() =>
                {
                    state["device_id"] = serde_json::json!(id.trim());
                    state["identity_present"] = serde_json::json!(true);
                    let policy = match read_private(&sidecar(&key, ".automatic-update"), 256) {
                        Ok(Some(raw)) => {
                            rca_native_agent::device_pairing::parse_auto_policy(&raw, id.trim())
                        }
                        Ok(None) => "off",
                        Err(_) => "unknown",
                    };
                    apply_policy_observation(&mut state, policy, false);
                }
                (Ok(None), Ok(None)) => {
                    state["identity_present"] = serde_json::json!(false);
                }
                _ => {}
            }
        } else {
            state["identity_present"] = serde_json::json!(false);
        }
        if let Some(base) = &base {
            let macos = base.join("macos");
            let unresolved = exists_owned_path(&base.join("v2-identity.pem.re-pair-transition"))?
                || (directory_present(&macos, true)?
                    && (exists_owned_path(&macos.join("switch.json"))?
                        || (directory_present(&macos.join("remote-upgrades"), true)?
                            && exists_owned_path(&macos.join("remote-upgrades/active.json"))?)));
            if unresolved {
                let policy = state["automatic_update"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_owned();
                apply_policy_observation(&mut state, &policy, true);
                return Ok(state);
            }
        }
        if !configured && !launcher && service_absent().is_ok() {
            state["installed"] = serde_json::json!(false);
            state["local_service"] = serde_json::json!("not_installed");
            if state["identity_present"] == false {
                apply_policy_observation(&mut state, "off", false);
            }
            return Ok(state);
        }
        let base = base.ok_or(())?;
        let key = base.join("v2-identity.pem");
        let current = installed(&home, &base)?;
        let stopped = owner_stopped(&key)?;
        let observed = observe_registration(&current.executable);
        let evidence = match (&observed, stopped) {
            (Registration::Present(Some(pid)), false) => connection_evidence(&current, &key, *pid),
            _ => None,
        };
        state["installed"] = serde_json::json!(true);
        state["version"] = serde_json::json!(current.version);
        state["installed_version"] = state["version"].clone();
        apply_connection_observation(&mut state, stopped, observed, evidence);
        Ok(state)
    }

    fn diagnose(action: &str, compact: bool) -> Result<(), ()> {
        let state = diagnostic_state().unwrap_or_else(|_| {
            default_diagnostics(if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            })
        });
        let response = diagnostic_response(action, &state);
        println!(
            "{}",
            if compact {
                response.to_string()
            } else {
                serde_json::to_string_pretty(&response).map_err(|_| ())?
            }
        );
        Ok(())
    }

    fn manage(action: &str) -> Result<(), ()> {
        let home = home()?;
        let base = identity_directory(&home, false)?;
        let _lock = lock_identity_directory(&base)?;
        let key = base.join("v2-identity.pem");
        for path in [
            base.join("macos/switch.json"),
            base.join("macos/remote-upgrades/active.json"),
            sidecar(&key, ".re-pair-transition"),
        ] {
            if exists_owned_path(&path)? {
                return Err(());
            }
        }
        let current = installed(&home, &base)?;
        let stopped = owner_stopped(&key)?;
        if action == "start" && !stopped {
            return Err(());
        }
        let pem = read_private(&key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        let id = id.trim();
        signed_session_proof(&pem, id, "ABCDEFGHIJKLMNOPQRSTUVWX").map_err(|_| ())?;
        let client = rca_native_agent::device_pairing::PairingClient::new(&current.endpoint)
            .map_err(|_| ())?;
        let prompt = if action == "start" {
            "Resume the previously stopped LaunchAgent?"
        } else {
            "Intentionally stop this user LaunchAgent?"
        };
        owner_confirm(prompt)?;
        let rechecked = installed(&home, &base)?;
        if rechecked.executable != current.executable
            || rechecked.endpoint != current.endpoint
            || rechecked.generation != current.generation
            || owner_stopped(&key)? != stopped
            || read_private(&key, 8192)?.as_deref() != Some(pem.as_str())
            || read_private(&sidecar(&key, ".device-id"), 128)?
                .as_deref()
                .map(str::trim)
                != Some(id)
        {
            return Err(());
        }
        let marker = base.join("macos/stopped");
        if action == "start" {
            let domain = format!("gui/{}", unsafe { libc::geteuid() });
            let after = now_ms()?;
            resume_owned(
                || observe_registration(&current.executable),
                || {
                    client.owner_intent(&pem, id, "stop").map_err(|_| ())?;
                    client.owner_intent(&pem, id, "resume").map_err(|_| ())
                },
                || {
                    fs::remove_file(&marker).map_err(|_| ())?;
                    fs::File::open(marker.parent().ok_or(())?)
                        .and_then(|file| file.sync_all())
                        .map_err(|_| ())
                },
                || {
                    current.plist.to_str().is_some_and(|plist| {
                        launchctl(&["bootstrap", &domain, plist])
                            .is_ok_and(|(code, _, _)| code == Some(0))
                    })
                },
                || await_online(&current, &key, after),
                || {
                    if !owner_stopped(&key)? {
                        write_new(&marker, b"stopped\n")?;
                    }
                    unregister_owned(
                        || observe_registration(&current.executable),
                        || {
                            launchctl(&["bootout", &service_target()])
                                .is_ok_and(|(code, _, _)| code == Some(0))
                        },
                        || std::thread::sleep(Duration::from_millis(250)),
                        true,
                    )
                },
            )
            .map_err(|_| {
                eprintln!("Resume unconfirmed; inspect status before retrying.");
            })?;
            println!(
                "{}",
                serde_json::json!({"status":"connected_observed","cloud":"signed_WSS_observed"})
            );
            return Ok(());
        }
        let confirmed = stop_owned(
            || {
                if stopped {
                    Ok(())
                } else {
                    write_new(&marker, b"stopped\n")
                }
            },
            || client.owner_intent(&pem, id, "stop").is_ok(),
            || observe_registration(&current.executable),
            || launchctl(&["bootout", &service_target()]).is_ok_and(|(code, _, _)| code == Some(0)),
            || std::thread::sleep(Duration::from_millis(250)),
        )?;
        println!(
            "{}",
            serde_json::json!({"status":"intentionally_stopped",
            "cloud":if confirmed {"confirmed"} else {"unconfirmed"}})
        );
        Ok(())
    }

    fn native_target() -> &'static str {
        if cfg!(target_arch = "aarch64") {
            "darwin-arm64"
        } else {
            "darwin-x64"
        }
    }

    fn current_bundle() -> Result<PathBuf, ()> {
        let executable =
            fs::canonicalize(std::env::current_exe().map_err(|_| ())?).map_err(|_| ())?;
        let root = executable.ancestors().nth(4).ok_or(())?;
        if executable != root.join(darwin_package::ENTRY) {
            return Err(());
        }
        Ok(root.to_owned())
    }

    fn ensure_owner_directory(parent: &Path, name: &str, private: bool) -> Result<PathBuf, ()> {
        use std::os::unix::fs::DirBuilderExt;
        let path = parent.join(name);
        match fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => (),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
            Err(_) => return Err(()),
        }
        owner_directory(parent, name, private)
    }

    fn sync_remove(path: &Path) -> Result<(), ()> {
        fs::remove_file(path).map_err(|_| ())?;
        fs::File::open(path.parent().ok_or(())?)
            .and_then(|file| file.sync_all())
            .map_err(|_| ())
    }

    fn owner_confirm(prompt: &str) -> Result<(), ()> {
        use std::io::{IsTerminal, Write};
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(());
        }
        print!("{prompt} Confirm [y/N]: ");
        std::io::stdout().flush().map_err(|_| ())?;
        let mut answer = String::new();
        std::io::stdin().read_line(&mut answer).map_err(|_| ())?;
        matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
            .then_some(())
            .ok_or(())
    }

    fn pair_identity(
        key: &Path,
        client: &rca_native_agent::device_pairing::PairingClient,
        name: &str,
        temporary: bool,
    ) -> Result<(), ()> {
        let mode = if temporary { "temporary" } else { "permanent" };
        pair_or_repair(
            key,
            client,
            |pem, existing| {
                let id = client
                    .pair(pem, existing, name, temporary, |pending| {
                        println!("{}", client.approval_instruction(pending, mode))
                    })
                    .map_err(|_| ())?;
                if !temporary {
                    client.verify_permanent_grant(&id).map_err(|_| ())?;
                }
                Ok(id)
            },
            false,
        )
    }

    // Bootstrap verifies the pinned release archive before executing this
    // entrypoint; independently check the extracted private inventory.
    fn install_local(endpoint: &str, name: &str, version: &str, source: &str) -> Result<(), ()> {
        let bundle = current_bundle()?;
        let package = darwin_package::verify(&bundle, native_target())?;
        if package.version != version || package.source != source {
            return Err(());
        }
        let client =
            rca_native_agent::device_pairing::PairingClient::new(endpoint).map_err(|_| ())?;
        let generation = new_generation()?;
        native_plist(&bundle.join(darwin_package::ENTRY), endpoint, &generation)?;
        let _supervisor = checked_supervisor()?;
        owner_confirm(&format!(
            "Install {version} as this user's login LaunchAgent?"
        ))?;
        let home = fs::canonicalize(home()?).map_err(|_| ())?;
        unsafe {
            libc::umask(0o077);
        }
        let (key, _lock) = pairing_store(&home, false)?;
        let base = key.parent().ok_or(())?;
        let macos = ensure_owner_directory(base, "macos", true)?;
        let programs = ensure_owner_directory(&macos, "programs", true)?;
        let agents = ensure_owner_directory(
            &ensure_owner_directory(&home, "Library", false)?,
            "LaunchAgents",
            false,
        )?;
        let plist = agents.join(format!("{LABEL}.plist"));
        let cli = ensure_owner_directory(&home.join(".local"), "bin", false)?.join("rca");
        let journal = macos.join("switch.json");
        let stopped = owner_stopped(&key)?;
        if exists_owned_path(&plist)? || exists_owned_path(&cli)? || exists_owned_path(&journal)? {
            return Err(());
        }
        service_absent()?;
        let endpoint_file = macos.join("endpoint");
        let stored = read_private(&endpoint_file, 2048)?;
        if stored.as_ref().is_some_and(|s| s.trim() != endpoint) {
            return Err(());
        }
        let destination = programs.join(format!("{}-{}", package.version, package.target));
        if exists_owned_path(&destination)? {
            if !darwin_package::same_package(&bundle, &destination, &package)? {
                return Err(());
            }
        } else {
            let stage = darwin_package::stage(&bundle, &programs, &package)?;
            if !darwin_package::same_package(&bundle, &stage, &package)? {
                return Err(());
            }
            move_owned_exclusive(&stage, &destination)?;
        }
        if stopped {
            // Uninstall is distinct from revocation. A retained OFF identity
            // must not be silently re-paired or resumed by reinstall.
            let pem = read_private(&key, 8192)?.ok_or(())?;
            let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
            signed_session_proof(&pem, id.trim(), "ABCDEFGHIJKLMNOPQRSTUVWX").map_err(|_| ())?;
        } else {
            pair_identity(&key, &client, name, false)?;
        }
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        client.verify_permanent_grant(id.trim()).map_err(|_| ())?;
        service_absent()?;
        if exists_owned_path(&plist)? || exists_owned_path(&cli)? {
            return Err(());
        }
        let executable = destination.join(darwin_package::ENTRY);
        let raw = native_plist(&executable, endpoint, &generation)?;
        let cli_text = native_cli(&executable)?;
        let record = serde_json::json!({"version":format!("{}-{}",package.version,package.target),
            "previous":null,"generation":generation,"stopped":stopped,"phase":"switch_pending"});
        // Endpoint is retained with the approved identity; persist it before
        // reserving the installation switch, so an interrupted pre-switch
        // install can be retried without guessing the origin.
        if stored.is_none() {
            write_new(&endpoint_file, format!("{endpoint}\n").as_bytes())?;
        }
        write_new(&journal, format!("{record}\n").as_bytes())?;
        write_new(&plist, raw.as_bytes())?;
        let current = Installed {
            executable,
            endpoint: endpoint.to_owned(),
            version: version.to_owned(),
            generation,
            plist,
        };
        if stopped && observe_registration(&current.executable) != Registration::Absent {
            return Err(());
        }
        if !stopped && !activate(&current, &key) {
            unregister_owned(
                || observe_registration(&current.executable),
                || {
                    launchctl(&["bootout", &service_target()])
                        .is_ok_and(|(code, _, _)| code == Some(0))
                },
                || std::thread::sleep(Duration::from_millis(250)),
                true,
            )?;
            if read_private(&current.plist, 65536)?.as_deref() != Some(raw.as_str()) {
                return Err(());
            }
            sync_remove(&current.plist)?;
            sync_remove(&journal)?;
            eprintln!(
                "Initial activation failed; approved identity and verified package retained."
            );
            return Err(());
        }
        write_executable(&cli, cli_text.as_bytes())?;
        sync_remove(&journal)?;
        println!(
            "{}",
            serde_json::json!({"status":if stopped {"stopped_preserved"}else{"connected_observed"},
            "version":version,"cli":cli})
        );
        Ok(())
    }

    fn gate(
        key: &Path,
        command: rca_native_agent::upgrade_control::UpgradeCommand,
    ) -> Result<bool, ()> {
        rca_native_agent::upgrade_control::owner_gate(key, command).map_err(|_| ())
    }

    fn unregister(current: &Installed) -> Result<(), ()> {
        unregister_owned(
            || observe_registration(&current.executable),
            || launchctl(&["bootout", &service_target()]).is_ok_and(|(code, _, _)| code == Some(0)),
            || std::thread::sleep(Duration::from_millis(250)),
            true,
        )
    }

    fn activate(current: &Installed, key: &Path) -> bool {
        let Ok(after) = now_ms() else {
            return false;
        };
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        current.plist.to_str().is_some_and(|path| {
            launchctl(&["bootstrap", &domain, path]).is_ok_and(|(code, _, _)| code == Some(0))
        }) && await_online(current, key, after)
    }

    fn binding_digest(fields: &[&str]) -> String {
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        for field in fields {
            digest.update((field.len() as u64).to_be_bytes());
            digest.update(field.as_bytes());
        }
        format!("{:x}", digest.finalize())
    }

    fn restart_binding(home: &Path, base: &Path, current: &Installed) -> Result<String, ()> {
        let key = base.join("v2-identity.pem");
        let checked = installed(home, base)?;
        if checked.executable != current.executable
            || checked.generation != current.generation
            || checked.endpoint != current.endpoint
            || owner_stopped(&key)?
            || exists_owned_path(&base.join("macos/remote-upgrades/active.json"))?
            || exists_owned_path(&sidecar(&key, ".re-pair-transition"))?
        {
            return Err(());
        }
        let pem = read_private(&key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        signed_session_proof(&pem, id.trim(), "ABCDEFGHIJKLMNOPQRSTUVWX").map_err(|_| ())?;
        let (_, cli) = startup_paths(home)?;
        let fields = [
            pem,
            id,
            read_private(&checked.plist, 65536)?.ok_or(())?,
            read_executable(&cli)?.ok_or(())?,
            read_private(&base.join("macos/endpoint"), 2048)?.ok_or(())?,
        ];
        Ok(binding_digest(&fields.each_ref().map(String::as_str)))
    }

    fn restart_local() -> Result<(), ()> {
        use rca_native_agent::upgrade_control::UpgradeCommand as Gate;
        let home = fs::canonicalize(home()?).map_err(|_| ())?;
        let base = identity_directory(&home, false)?;
        let _lock = lock_identity_directory(&base)?;
        let key = base.join("v2-identity.pem");
        let journal = base.join("macos/switch.json");
        if exists_owned_path(&journal)? {
            return Err(());
        }
        let current = installed(&home, &base)?;
        let binding = restart_binding(&home, &base, &current)?;
        let Registration::Present(Some(pid)) = observe_registration(&current.executable) else {
            return Err(());
        };
        if !connection_evidence(&current, &key, pid).is_some_and(|(_, _, online)| online) {
            return Err(());
        }
        owner_confirm("Restart this Owner-ON LaunchAgent, retaining identity and receipts?")?;
        if restart_binding(&home, &base, &current)? != binding
            || observe_registration(&current.executable) != Registration::Present(Some(pid))
        {
            return Err(());
        }
        let mut record = RestartRecord {
            phase: "restart_preparing".to_owned(),
            version: format!("{}-{}", current.version, native_target()),
            generation: current.generation.clone(),
            binding,
            pid,
        };
        let raw = format!("{}\n", serde_json::to_string(&record).map_err(|_| ())?);
        write_new(&journal, raw.as_bytes())?;
        let unchanged = |record: &RestartRecord, raw: &str| -> Result<(), ()> {
            if restart_binding(&home, &base, &current)? != record.binding
                || read_private(&journal, 65536)?.as_deref() != Some(raw)
            {
                return Err(());
            }
            Ok(())
        };
        if !gate(&key, Gate::Freeze)? {
            unchanged(&record, &raw)?;
            sync_remove(&journal)?;
            return Err(());
        }
        unchanged(&record, &raw)?;
        if observe_registration(&current.executable) != Registration::Present(Some(pid))
            || !gate(&key, Gate::VerifyFrozen)?
        {
            return Err(());
        }
        unchanged(&record, &raw)?;
        if observe_registration(&current.executable) != Registration::Present(Some(pid)) {
            return Err(());
        }
        // Before any possibly ambiguous restart request, persist the phase.
        // A preparing journal can release the original frozen Agent; after
        // the request boundary only a proven replacement may retire it.
        record.phase = "restart_pending".to_owned();
        let pending = format!("{}\n", serde_json::to_string(&record).map_err(|_| ())?);
        replace_owned(&journal, &raw, &pending, 0o600)?;
        let raw = pending;
        unchanged(&record, &raw)?;
        if observe_registration(&current.executable) != Registration::Present(Some(pid)) {
            return Err(());
        }
        let after = now_ms()?;
        if !launchctl(&["kickstart", "-k", &service_target()])
            .is_ok_and(|(code, _, _)| code == Some(0))
        {
            return Err(());
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            let registration = observe_registration(&current.executable);
            let online = match &registration {
                Registration::Present(Some(next)) if *next != pid => {
                    connection_evidence(&current, &key, *next)
                        .is_some_and(|(_, at, online)| online && at >= after)
                }
                _ => false,
            };
            if online
                && record.replacement_proven(
                    &restart_binding(&home, &base, &current)?,
                    &registration,
                    online,
                )
            {
                unchanged(&record, &raw)?;
                if observe_registration(&current.executable) != registration {
                    return Err(());
                }
                sync_remove(&journal)?;
                println!(
                    "{}",
                    serde_json::json!({"status":"restarted","signed_wss":"connected_observed"})
                );
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        eprintln!(
            "Replacement signed Agent unconfirmed; use recover to inspect the retained journal."
        );
        Err(())
    }

    fn recover_restart(
        home: &Path,
        base: &Path,
        key: &Path,
        journal: &Path,
        raw: &str,
        record: &RestartRecord,
    ) -> Result<(), ()> {
        let current = installed(home, base)?;
        if record.version != format!("{}-{}", current.version, native_target())
            || record.generation != current.generation
        {
            return Err(());
        }
        let evidence = || -> Result<(bool, bool), ()> {
            if read_private(journal, 65536)?.as_deref() != Some(raw) {
                return Err(());
            }
            let binding = restart_binding(home, base, &current)?;
            let registration = observe_registration(&current.executable);
            let online = match &registration {
                Registration::Present(Some(pid)) => {
                    connection_evidence(&current, key, *pid).is_some_and(|(_, _, online)| online)
                }
                _ => false,
            };
            Ok((
                record.replacement_proven(&binding, &registration, online),
                record.original_recoverable(&binding, &registration, online),
            ))
        };
        let outcome = evidence()?;
        let prompt = match outcome {
            (true, false) => {
                "Retire the completed restart journal? Identity and receipts are retained."
            }
            (false, true) => "Abandon the restart before dispatch and release the original Agent?",
            _ => return Err(()),
        };
        owner_confirm(prompt)?;
        if evidence()? != outcome {
            return Err(());
        }
        if outcome.1 {
            use rca_native_agent::upgrade_control::UpgradeCommand as Gate;
            if !gate(key, Gate::Release)? || evidence()? != outcome {
                return Err(());
            }
        }
        if read_private(journal, 65536)?.as_deref() != Some(raw) {
            return Err(());
        }
        sync_remove(journal)?;
        println!("Restart reconciled; identity and receipts retained.");
        Ok(())
    }

    fn upgrade_local(endpoint: &str, version: &str, source: &str) -> Result<(), ()> {
        use rca_native_agent::upgrade_control::UpgradeCommand as Gate;
        let bundle = current_bundle()?;
        let package = darwin_package::verify(&bundle, native_target())?;
        if package.version != version || package.source != source {
            return Err(());
        }
        let _supervisor = checked_supervisor()?;
        let home = fs::canonicalize(home()?).map_err(|_| ())?;
        let base = identity_directory(&home, false)?;
        let _lock = lock_identity_directory(&base)?;
        let key = base.join("v2-identity.pem");
        let journal = base.join("macos/switch.json");
        for path in [
            &journal,
            &base.join("macos/remote-upgrades/active.json"),
            &sidecar(&key, ".re-pair-transition"),
        ] {
            if exists_owned_path(path)? {
                return Err(());
            }
        }
        let programs = program_directory(&base)?;
        let (plist, cli) = startup_paths(&home)?;
        let stored = read_private(&base.join("macos/endpoint"), 2048)?.ok_or(())?;
        if stored.trim() != endpoint {
            return Err(());
        }
        let previous = read_private(&plist, 65536)?.ok_or(())?;
        let old = resolve_installation(&programs, &plist, &previous, endpoint)?;
        let old_cli = native_cli(&old.executable)?;
        if read_executable(&cli)?.as_deref() != Some(old_cli.as_str())
            || !darwin_package::forward_version(&old.version, version)
        {
            return Err(());
        }
        let stopped = owner_stopped(&key)?;
        let prior = observe_registration(&old.executable);
        if !matches!(
            (&prior, stopped),
            (Registration::Absent, true) | (Registration::Present(Some(_)), false)
        ) {
            return Err(());
        }
        let pem = read_private(&key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        signed_session_proof(&pem, id.trim(), "ABCDEFGHIJKLMNOPQRSTUVWX").map_err(|_| ())?;
        if let Registration::Present(Some(pid)) = &prior {
            if !connection_evidence(&old, &key, *pid).is_some_and(|(_, _, online)| online) {
                return Err(());
            }
        }
        owner_confirm(&format!(
            "Upgrade {} to {version}, retaining identity and receipts?",
            old.version
        ))?;
        let destination = programs.join(format!("{}-{}", package.version, package.target));
        if exists_owned_path(&destination)? {
            if !darwin_package::same_package(&bundle, &destination, &package)? {
                return Err(());
            }
        } else {
            let stage = darwin_package::stage(&bundle, &programs, &package)?;
            if !darwin_package::same_package(&bundle, &stage, &package)? {
                return Err(());
            }
            move_owned_exclusive(&stage, &destination)?;
        }
        let next = Installed {
            executable: destination.join(darwin_package::ENTRY),
            endpoint: endpoint.to_owned(),
            version: version.to_owned(),
            generation: new_generation()?,
            plist: plist.clone(),
        };
        let next_raw = native_plist(&next.executable, endpoint, &next.generation)?;
        let next_cli = native_cli(&next.executable)?;
        let identity_unchanged = || -> Result<(), ()> {
            if read_private(&base.join("macos/endpoint"), 2048)?.as_deref() != Some(stored.as_str())
                || owner_stopped(&key)? != stopped
                || read_private(&key, 8192)?.as_deref() != Some(pem.as_str())
                || read_private(&sidecar(&key, ".device-id"), 128)?.as_deref() != Some(id.as_str())
            {
                return Err(());
            }
            Ok(())
        };
        let unchanged = || -> Result<(), ()> {
            identity_unchanged()?;
            if read_private(&plist, 65536)?.as_deref() != Some(previous.as_str())
                || read_executable(&cli)?.as_deref() != Some(old_cli.as_str())
                || observe_registration(&old.executable) != prior
            {
                return Err(());
            }
            Ok(())
        };
        unchanged()?;
        let record = SwitchRecord {
            version: format!("{version}-{}", package.target),
            previous: Some(previous.clone()),
            binding: Some(binding_digest(&[&pem, &id, &stored, &previous, &next_raw])),
            generation: next.generation.clone(),
            stopped,
            phase: "switch_pending".to_owned(),
        };
        let raw = format!("{}\n", serde_json::to_string(&record).map_err(|_| ())?);
        write_new(&journal, raw.as_bytes())?;
        if !stopped {
            // Busy is a confirmed refusal; an uncertain freeze retains the journal.
            if !gate(&key, Gate::Freeze)? {
                if read_private(&journal, 65536)?.as_deref() == Some(raw.as_str()) {
                    sync_remove(&journal)?;
                }
                return Err(());
            }
            if unchanged().is_err() || !gate(&key, Gate::VerifyFrozen)? {
                return Err(());
            }
            unchanged()?;
            if read_private(&journal, 65536)?.as_deref() != Some(raw.as_str()) {
                return Err(());
            }
            unregister(&old)?;
        }
        identity_unchanged()?;
        if observe_registration(&old.executable) != Registration::Absent
            || read_private(&journal, 65536)?.as_deref() != Some(raw.as_str())
        {
            return Err(());
        }
        replace_owned(&plist, &previous, &next_raw, 0o600)?;
        if !stopped && !activate(&next, &key) {
            // Only restore the prior plist after replacement registration
            // has been confirmed absent. Never bootstrap over unknown state.
            unregister(&next)?;
            replace_owned(&plist, &next_raw, &previous, 0o600)?;
            if !activate(&old, &key) {
                return Err(());
            }
            identity_unchanged()?;
            if read_private(&journal, 65536)?.as_deref() != Some(raw.as_str()) {
                return Err(());
            }
            sync_remove(&journal)?;
            eprintln!("Replacement activation failed; original version is confirmed online.");
            return Err(());
        }
        if stopped && observe_registration(&next.executable) != Registration::Absent {
            return Err(());
        }
        identity_unchanged()?;
        replace_owned(&cli, &old_cli, &next_cli, 0o700)?;
        if read_private(&journal, 65536)?.as_deref() != Some(raw.as_str()) {
            return Err(());
        }
        sync_remove(&journal)?;
        println!(
            "{}",
            serde_json::json!({"status":if stopped {"stopped_preserved"}else{"connected_observed"},"version":version})
        );
        Ok(())
    }

    fn ensure_no_other_programs(programs: &Path) -> Result<(), ()> {
        let (code, output, _) = bounded_command(
            "/bin/ps",
            &["-axww", "-o", "pid=,uid=,command="],
            2 * 1024 * 1024,
        )?;
        if code != Some(0)
            || !no_other_programs(
                &output,
                programs,
                unsafe { libc::geteuid() },
                std::process::id(),
            )
        {
            return Err(());
        }
        Ok(())
    }

    fn uninstall_local() -> Result<(), ()> {
        use rca_native_agent::upgrade_control::UpgradeCommand as Gate;
        let home = fs::canonicalize(home()?).map_err(|_| ())?;
        let base = identity_directory(&home, false)?;
        let _lock = lock_identity_directory(&base)?;
        let key = base.join("v2-identity.pem");
        let journal = base.join("macos/switch.json");
        for path in [
            &journal,
            &base.join("macos/remote-upgrades/active.json"),
            &sidecar(&key, ".re-pair-transition"),
        ] {
            if exists_owned_path(path)? {
                return Err(());
            }
        }
        let current = installed(&home, &base)?;
        let programs = program_directory(&base)?;
        let roots = darwin_package::reviewed_programs(&programs, native_target())?;
        if !roots
            .iter()
            .any(|root| root.join(darwin_package::ENTRY) == current.executable)
        {
            return Err(());
        }
        let (plist, cli) = startup_paths(&home)?;
        let previous = native_plist(&current.executable, &current.endpoint, &current.generation)?;
        let launcher = native_cli(&current.executable)?;
        let stopped = owner_stopped(&key)?;
        let prior = observe_registration(&current.executable);
        if !matches!(
            (&prior, stopped),
            (Registration::Absent, true) | (Registration::Present(Some(_)), false)
        ) {
            return Err(());
        }
        let pem = read_private(&key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        signed_session_proof(&pem, id.trim(), "ABCDEFGHIJKLMNOPQRSTUVWX").map_err(|_| ())?;
        owner_confirm(&format!("Uninstall {} reviewed version(s)? Identity, receipts and cloud authorization are retained.",roots.len()))?;
        let unchanged = || -> Result<(), ()> {
            if read_private(&plist, 65536)?.as_deref() != Some(previous.as_str())
                || read_executable(&cli)?.as_deref() != Some(launcher.as_str())
                || read_private(&key, 8192)?.as_deref() != Some(pem.as_str())
                || read_private(&sidecar(&key, ".device-id"), 128)?.as_deref() != Some(id.as_str())
                || owner_stopped(&key)? != stopped
                || darwin_package::reviewed_programs(&programs, native_target())? != roots
                || exists_owned_path(&base.join("macos/remote-upgrades/active.json"))?
            {
                return Err(());
            }
            Ok(())
        };
        unchanged()?;
        if observe_registration(&current.executable) != prior {
            return Err(());
        }
        // The existing journal reserves the entire lifecycle mutation.
        let mut record = UninstallRecord {
            phase: "uninstall_pending".to_owned(),
            version: format!("{}-{}", current.version, native_target()),
            generation: current.generation.clone(),
            stopped,
            binding: binding_digest(&[&pem, &id, &current.endpoint]),
            inventory: None,
        };
        let raw = format!("{}\n", serde_json::to_string(&record).map_err(|_| ())?);
        write_new(&journal, raw.as_bytes())?;
        if !stopped {
            if !gate(&key, Gate::Freeze)? {
                if read_private(&journal, 65536)?.as_deref() == Some(raw.as_str()) {
                    sync_remove(&journal)?;
                }
                return Err(());
            }
            unchanged()?;
            if observe_registration(&current.executable) != prior
                || !gate(&key, Gate::VerifyFrozen)?
            {
                return Err(());
            }
        }
        unregister(&current)?;
        ensure_no_other_programs(&programs)?;
        unchanged()?;
        if read_private(&journal, 65536)?.as_deref() != Some(raw.as_str()) {
            return Err(());
        }
        let inventory = roots
            .iter()
            .map(|root| {
                Ok((
                    root.file_name()
                        .and_then(|n| n.to_str())
                        .ok_or(())?
                        .to_owned(),
                    darwin_package::removal_inventory(root, native_target())?,
                ))
            })
            .collect::<Result<std::collections::BTreeMap<_, _>, ()>>()?;
        unchanged()?;
        ensure_no_other_programs(&programs)?;
        service_absent()?;
        record.phase = "uninstall_removing".into();
        record.inventory = Some(inventory);
        let next_raw = format!("{}\n", serde_json::to_string(&record).map_err(|_| ())?);
        if next_raw.len() > 65536 {
            return Err(());
        }
        replace_owned(&journal, &raw, &next_raw, 0o600)?;
        finish_uninstall(&home, &base, &next_raw, &record, false)
    }

    // The existing lock is held by the caller. Cleanup never expands beyond
    // the inventory captured before the first removal.
    fn finish_uninstall(
        home: &Path,
        base: &Path,
        raw: &str,
        record: &UninstallRecord,
        attended: bool,
    ) -> Result<(), ()> {
        let inventory = record.inventory.as_ref().ok_or(())?;
        if attended {
            let bundle = current_bundle()?;
            let verified = darwin_package::removal_inventory(&bundle, native_target());
            if verified.as_ref().ok() != inventory.get(&record.version) || verified.is_err() {
                eprintln!("Recovery requires the exact reviewed original package; use its independently verified extracted bundle.");
                return Err(());
            }
        }
        let programs = program_directory(base)?;
        let (plist, cli) = startup_paths(home)?;
        let key = base.join("v2-identity.pem");
        let journal = base.join("macos/switch.json");
        let endpoint_file = base.join("macos/endpoint");
        let endpoint_raw = read_private(&endpoint_file, 2048)?.ok_or(())?;
        let endpoint = endpoint_raw.trim();
        let pem = read_private(&key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        signed_session_proof(&pem, id.trim(), "ABCDEFGHIJKLMNOPQRSTUVWX").map_err(|_| ())?;
        if binding_digest(&[&pem, &id, endpoint]) != record.binding {
            return Err(());
        }
        let executable = programs.join(&record.version).join(darwin_package::ENTRY);
        let expected = native_plist(&executable, endpoint, &record.generation)?;
        let launcher = native_cli(&executable)?;
        let unchanged = || -> Result<(), ()> {
            if read_private(&journal, 65536)?.as_deref() != Some(raw)
                || read_private(&key, 8192)?.as_deref() != Some(pem.as_str())
                || read_private(&sidecar(&key, ".device-id"), 128)?.as_deref() != Some(id.as_str())
                || read_private(&endpoint_file, 2048)?.as_deref() != Some(endpoint_raw.as_str())
                || owner_stopped(&key)? != record.stopped
                || exists_owned_path(&base.join("macos/remote-upgrades/active.json"))?
                || exists_owned_path(&sidecar(&key, ".re-pair-transition"))?
            {
                return Err(());
            }
            service_absent()?;
            ensure_no_other_programs(&programs)
        };
        let inspect = || -> Result<(bool, bool), ()> {
            unchanged()?;
            let configuration = read_private(&plist, 65536)?;
            let command = read_executable(&cli)?;
            if configuration.as_ref().is_some_and(|v| v != &expected)
                || command.as_ref().is_some_and(|v| v != &launcher)
            {
                return Err(());
            }
            for entry in fs::read_dir(&programs).map_err(|_| ())? {
                let entry = entry.map_err(|_| ())?;
                let name = entry.file_name();
                let files = inventory.get(name.to_str().ok_or(())?).ok_or(())?;
                darwin_package::verify_remaining(&entry.path(), files)?;
            }
            Ok((configuration.is_some(), command.is_some()))
        };
        if attended {
            inspect()?;
            owner_confirm("Complete the interrupted uninstall of the reviewed packages? Identity and receipts are retained.")?;
        }
        let (configuration, _) = inspect()?;
        if configuration {
            sync_remove(&plist)?;
        }
        for (name, files) in inventory {
            unchanged()?;
            darwin_package::remove_remaining(&programs.join(name), files)?;
        }
        let (_, command) = inspect()?;
        if command {
            sync_remove(&cli)?;
        }
        if inspect()? != (false, false) || fs::read_dir(&programs).map_err(|_| ())?.next().is_some()
        {
            return Err(());
        }
        sync_remove(&journal)?;
        println!(
            "{}",
            serde_json::json!({"status":"uninstalled","removed_versions":inventory.len(),"identity_preserved":true,"receipts_preserved":true,"cloud_revocation":"not_performed"})
        );
        Ok(())
    }

    fn recover_uninstall(
        home: &Path,
        base: &Path,
        key: &Path,
        journal: &Path,
        raw: &str,
        record: &UninstallRecord,
    ) -> Result<(), ()> {
        use rca_native_agent::upgrade_control::UpgradeCommand as Gate;
        if record.phase == "uninstall_removing" {
            return finish_uninstall(home, base, raw, record, true);
        }
        let programs = program_directory(base)?;
        let (plist, cli) = startup_paths(home)?;
        let root = programs.join(&record.version);
        let executable = root.join(darwin_package::ENTRY);
        let endpoint_file = base.join("macos/endpoint");
        let endpoint_raw = read_private(&endpoint_file, 2048)?.ok_or(())?;
        let endpoint = endpoint_raw.trim();
        let expected = native_plist(&executable, endpoint, &record.generation)?;
        let launcher = native_cli(&executable)?;
        let pem = read_private(key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(key, ".device-id"), 128)?.ok_or(())?;
        signed_session_proof(&pem, id.trim(), "ABCDEFGHIJKLMNOPQRSTUVWX").map_err(|_| ())?;
        if binding_digest(&[&pem, &id, endpoint]) != record.binding {
            return Err(());
        }
        let unchanged = || -> Result<(), ()> {
            if read_private(journal, 65536)?.as_deref() != Some(raw)
                || read_private(key, 8192)?.as_deref() != Some(pem.as_str())
                || read_private(&sidecar(key, ".device-id"), 128)?.as_deref() != Some(id.as_str())
                || read_private(&endpoint_file, 2048)?.as_deref() != Some(endpoint_raw.as_str())
                || owner_stopped(key)? != record.stopped
                || exists_owned_path(&base.join("macos/remote-upgrades/active.json"))?
                || exists_owned_path(&sidecar(key, ".re-pair-transition"))?
            {
                return Err(());
            }
            Ok(())
        };
        let observe = || -> Result<UninstallRecovery, ()> {
            unchanged()?;
            let configuration = read_private(&plist, 65536)?;
            let command = read_executable(&cli)?;
            if configuration.as_ref().is_some_and(|v| v != &expected)
                || command.as_ref().is_some_and(|v| v != &launcher)
            {
                return Err(());
            }
            let roots = darwin_package::reviewed_programs(&programs, native_target())?;
            let registration = observe_registration(&executable);
            let online = if configuration.is_some() && command.is_some() {
                let current = installed(home, base)?;
                if current.executable != executable
                    || current.generation != record.generation
                    || !roots.contains(&root)
                {
                    return Err(());
                }
                match &registration {
                    Registration::Present(Some(pid)) => connection_evidence(&current, key, *pid)
                        .is_some_and(|(_, _, online)| online),
                    _ => false,
                }
            } else {
                false
            };
            if registration == Registration::Absent {
                ensure_no_other_programs(&programs)?;
            }
            Ok(record.recovery(
                configuration.is_some(),
                command.is_some(),
                roots.is_empty(),
                &registration,
                online,
            ))
        };
        let outcome = observe()?;
        let prompt = match outcome {
            UninstallRecovery::RetainOnline | UninstallRecovery::RetainStopped => {
                "Abandon the interrupted uninstall and retain the original installation?"
            }
            UninstallRecovery::Restore => {
                "Abandon the interrupted uninstall and restore the original Owner-ON service?"
            }
            UninstallRecovery::Unknown => {
                eprintln!("Partial or unconfirmed uninstall; journal retained.");
                return Err(());
            }
        };
        owner_confirm(prompt)?;
        if observe()? != outcome {
            return Err(());
        }
        match outcome {
            UninstallRecovery::Restore => {
                let current = installed(home, base)?;
                let client = rca_native_agent::device_pairing::PairingClient::new(endpoint)
                    .map_err(|_| ())?;
                client.verify_permanent_grant(id.trim()).map_err(|_| ())?;
                if observe()? != outcome
                    || !activate(&current, key)
                    || observe()? != UninstallRecovery::RetainOnline
                {
                    return Err(());
                }
            }
            UninstallRecovery::RetainOnline => {
                if !gate(key, Gate::Release)? || observe()? != outcome {
                    return Err(());
                }
            }
            UninstallRecovery::RetainStopped => {
                std::thread::sleep(Duration::from_millis(250));
                if observe()? != outcome {
                    return Err(());
                }
            }
            UninstallRecovery::Unknown => return Err(()),
        }
        unchanged()?;
        sync_remove(journal)?;
        println!("Uninstall reconciled; identity and receipts retained.");
        Ok(())
    }

    fn recover_switch() -> Result<(), ()> {
        use rca_native_agent::upgrade_control::UpgradeCommand as Gate;
        let home = fs::canonicalize(home()?).map_err(|_| ())?;
        let base = identity_directory(&home, false)?;
        let _lock = lock_identity_directory(&base)?;
        let key = base.join("v2-identity.pem");
        let journal = base.join("macos/switch.json");
        for path in [
            base.join("macos/remote-upgrades/active.json"),
            sidecar(&key, ".re-pair-transition"),
        ] {
            if exists_owned_path(&path)? {
                return Err(());
            }
        }
        let Some(raw) = read_private(&journal, 65536)? else {
            println!("No unresolved switch.");
            return Ok(());
        };
        if let Ok(restart) = RestartRecord::parse(&raw, native_target()) {
            return recover_restart(&home, &base, &key, &journal, &raw, &restart);
        }
        if let Ok(uninstall) = UninstallRecord::parse(&raw, native_target()) {
            return recover_uninstall(&home, &base, &key, &journal, &raw, &uninstall);
        }
        let record = SwitchRecord::parse(&raw, native_target())?;
        if owner_stopped(&key)? != record.stopped {
            return Err(());
        }
        let programs = program_directory(&base)?;
        let (plist, cli) = startup_paths(&home)?;
        let root = programs.join(&record.version);
        let package = darwin_package::verify(&root, native_target())?;
        if record.version != format!("{}-{}", package.version, package.target) {
            return Err(());
        }
        // Reconcile an interrupted initial installation only when the
        // original identity and the absence of active service are proven.
        let pem = read_private(&key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        signed_session_proof(&pem, id.trim(), "ABCDEFGHIJKLMNOPQRSTUVWX").map_err(|_| ())?;
        let unchanged = || -> Result<(), ()> {
            if read_private(&journal, 65536)?.as_deref() != Some(raw.as_str())
                || owner_stopped(&key)? != record.stopped
                || read_private(&key, 8192)?.as_deref() != Some(pem.as_str())
                || read_private(&sidecar(&key, ".device-id"), 128)?.as_deref() != Some(id.as_str())
            {
                return Err(());
            }
            Ok(())
        };
        let endpoint_path = base.join("macos/endpoint");
        let endpoint = read_private(&endpoint_path, 2048)?;
        let executable = root.join(darwin_package::ENTRY);
        let expected = endpoint
            .as_deref()
            .map(|value| native_plist(&executable, value.trim(), &record.generation))
            .transpose()?;
        let can_abandon = |configuration: Option<&str>| -> Result<bool, ()> {
            unchanged()?;
            if read_private(&endpoint_path, 2048)? != endpoint
                || read_private(&plist, 65536)?.as_deref() != configuration
                || darwin_package::verify(&root, native_target())? != package
            {
                return Err(());
            }
            let abandon = record.can_abandon_initial(
                configuration,
                expected.as_deref(),
                read_executable(&cli)?.as_deref(),
                &observe_registration(&executable),
            );
            if abandon {
                // Check the candidate package, not unrelated versions that
                // may have separate temporary identities.
                ensure_no_other_programs(&root)?;
            }
            Ok(abandon)
        };
        let configuration = read_private(&plist, 65536)?;
        if can_abandon(configuration.as_deref())? {
            owner_confirm("Abandon the interrupted initial installation? Identity and package retained; rerun the installer.")?;
            if !can_abandon(configuration.as_deref())? {
                return Err(());
            }
            std::thread::sleep(Duration::from_millis(250));
            if !can_abandon(configuration.as_deref())? {
                return Err(());
            }
            // A crash after writing the exact plist but before service
            // registration has no active installation to roll back to.
            // Remove only that journal-bound configuration, not a foreign
            // or already-registered service. Retain the journal on doubt.
            if configuration.is_some() {
                sync_remove(&plist)?;
            }
            if !can_abandon(None)? {
                return Err(());
            }
            std::thread::sleep(Duration::from_millis(250));
            if !can_abandon(None)? {
                return Err(());
            }
            sync_remove(&journal)?;
            println!("Initial installation not configured; rerun the installer. Identity and receipts retained.");
            return Ok(());
        }
        let endpoint_record = endpoint.ok_or(())?;
        let endpoint = endpoint_record.trim();
        let next = Installed {
            executable: root.join(darwin_package::ENTRY),
            endpoint: endpoint.to_owned(),
            version: package.version,
            generation: record.generation.clone(),
            plist: plist.clone(),
        };
        let next_raw = native_plist(&next.executable, endpoint, &next.generation)?;
        let next_cli = native_cli(&next.executable)?;
        let previous = record
            .previous
            .as_deref()
            .map(|old| resolve_installation(&programs, &plist, old, endpoint))
            .transpose()?;
        if previous
            .as_ref()
            .is_some_and(|old| !darwin_package::forward_version(&old.version, &next.version))
        {
            return Err(());
        }
        let previous_cli = previous
            .as_ref()
            .map(|old| native_cli(&old.executable))
            .transpose()?;
        let current_cli = read_executable(&cli)?;
        if current_cli != previous_cli && current_cli.as_deref() != Some(next_cli.as_str()) {
            return Err(());
        }
        let binding = record
            .previous
            .as_deref()
            .map(|old| binding_digest(&[&pem, &id, &endpoint_record, old, &next_raw]));
        let verify_binding = || -> Result<(), ()> {
            unchanged()?;
            if read_private(&endpoint_path, 2048)?.as_deref() != Some(endpoint_record.as_str())
                || (record.binding.is_some() && record.binding != binding)
                || (!record.stopped && previous.is_some() && record.binding.is_none())
            {
                return Err(());
            }
            Ok(())
        };
        let evidence = || -> Result<SwitchOutcome, ()> {
            verify_binding()?;
            if read_executable(&cli)? != current_cli {
                return Err(());
            }
            let configuration = read_private(&plist, 65536)?;
            let next_registration = observe_registration(&next.executable);
            let old_registration = previous
                .as_ref()
                .map(|old| observe_registration(&old.executable))
                .unwrap_or(Registration::Unknown);
            let online = |current: &Installed, registration: &Registration| match registration {
                Registration::Present(Some(pid)) => {
                    connection_evidence(current, &key, *pid).is_some_and(|(_, _, online)| online)
                }
                _ => false,
            };
            Ok(switch_outcome(
                configuration.as_deref() == Some(next_raw.as_str()),
                previous.is_some() && configuration.as_deref() == record.previous.as_deref(),
                record.stopped,
                &next_registration,
                &old_registration,
                online(&next, &next_registration),
                previous
                    .as_ref()
                    .is_some_and(|old| online(old, &old_registration)),
            ))
        };
        let mut outcome = evidence()?;
        let mut restored = false;
        if outcome == SwitchOutcome::Unknown {
            // A crash between bootout and bootstrap can leave no service.
            // Do not stop a registered service as part of this recovery.
            let absent = || -> Result<bool, ()> {
                verify_binding()?;
                if read_executable(&cli)? != current_cli {
                    return Err(());
                }
                let configuration = read_private(&plist, 65536)?;
                let registration = observe_registration(&next.executable);
                Ok(binding.as_deref().is_some_and(|binding| {
                    record.can_restore_previous(
                        binding,
                        configuration.as_deref(),
                        &next_raw,
                        &registration,
                    )
                }))
            };
            if !absent()? {
                eprintln!("Switch outcome unconfirmed; journal and both packages retained.");
                return Err(());
            }
            let old = previous.as_ref().ok_or(())?;
            let old_raw = record.previous.as_deref().ok_or(())?;
            owner_confirm("Restore the original version after the interrupted online switch?")?;
            unregister_owned(
                || observe_registration(&next.executable),
                || false,
                || std::thread::sleep(Duration::from_millis(250)),
                true,
            )?;
            ensure_no_other_programs(old.executable.parent().ok_or(())?)?;
            ensure_no_other_programs(next.executable.parent().ok_or(())?)?;
            if !absent()? {
                return Err(());
            }
            if read_private(&plist, 65536)?.as_deref() == Some(next_raw.as_str()) {
                replace_owned(&plist, &next_raw, old_raw, 0o600)?;
            }
            if read_private(&plist, 65536)?.as_deref() != Some(old_raw)
                || !absent()?
                || !activate(old, &key)
            {
                return Err(());
            }
            outcome = evidence()?;
            if outcome != SwitchOutcome::Rollback {
                return Err(());
            }
            restored = true;
        } else {
            owner_confirm("Reconcile the proven service configuration and local command?")?;
            if evidence()? != outcome {
                return Err(());
            }
        }
        let (desired, old) = match outcome {
            SwitchOutcome::Complete => (&next_cli, None),
            SwitchOutcome::Rollback => (previous_cli.as_ref().ok_or(())?, previous.as_ref()),
            SwitchOutcome::Unknown => return Err(()),
        };
        if let Some(old) = old {
            // A crash before bootout may leave the original service frozen.
            // This journal holds the exclusive owner lifecycle transaction.
            if !record.stopped
                && !restored
                && (!gate(&key, Gate::Release)?
                    || !matches!(
                        observe_registration(&old.executable),
                        Registration::Present(Some(_))
                    ))
            {
                return Err(());
            }
        }
        if evidence()? != outcome {
            return Err(());
        }
        match current_cli.as_deref() {
            Some(current) if current != desired => replace_owned(&cli, current, desired, 0o700)?,
            None => write_executable(&cli, desired.as_bytes())?,
            _ => (),
        }
        if read_private(&journal, 65536)?.as_deref() != Some(raw.as_str()) {
            return Err(());
        }
        sync_remove(&journal)?;
        println!("Switch reconciled; identity and receipts retained.");
        Ok(())
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
        pair_identity(&key, &client, name, temporary)?;
        if temporary {
            println!("Starting temporary foreground Agent; the Worker enforces the original 24h grant. Terminal exit disconnects, not revokes.");
            return run_agent(endpoint, &home, &key, None);
        }
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        client.verify_permanent_grant(id.trim()).map_err(|_| ())?;
        println!("Approved identity recovered; service has not been started.");
        Ok(())
    }

    // Match the installed manager's existing-identity reconciliation. This does
    // not enroll a replacement, alter Owner intent, or start/stop launchd.
    fn reconcile_installed_pair() -> Result<(), ()> {
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            eprintln!("Pair requires a local owner terminal.");
            return Err(());
        }
        let home = home()?;
        let base = identity_directory(&home, false)?;
        let _lock = lock_identity_directory(&base)?;
        let key = base.join("v2-identity.pem");
        for path in [
            base.join("macos/switch.json"),
            base.join("macos/remote-upgrades/active.json"),
            sidecar(&key, ".re-pair-transition"),
            sidecar(&key, ".re-pair-new"),
            sidecar(&key, ".re-pair-new.device-id"),
        ] {
            if exists_owned_path(&path)? {
                return Err(());
            }
        }
        let current = installed(&home, &base)?;
        let pem = read_private(&key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        let id = id.trim();
        if !valid_device_id(id) {
            return Err(());
        }
        let client = rca_native_agent::device_pairing::PairingClient::new(&current.endpoint)
            .map_err(|_| ())?;
        client.recover(&pem, Some(id)).map_err(|_| {
            eprintln!(
                "Existing identity could not be confirmed; identity and service were not changed."
            );
        })?;
        println!("Existing approved permanent identity preserved.");
        Ok(())
    }

    fn secure_input_local(request_id: &str) -> Result<(), ()> {
        use std::io::IsTerminal;
        if !valid_device_id(request_id)
            || !std::io::stdin().is_terminal()
            || !std::io::stdout().is_terminal()
        {
            return Err(());
        }
        let home = fs::canonicalize(home()?).map_err(|_| ())?;
        let base = identity_directory(&home, false)?;
        let key = base.join("v2-identity.pem");
        if owner_stopped(&key)? {
            return Err(());
        }
        for path in [
            base.join("macos/switch.json"),
            base.join("macos/remote-upgrades/active.json"),
            sidecar(&key, ".re-pair-transition"),
        ] {
            if exists_owned_path(&path)? {
                return Err(());
            }
        }
        let current = installed(&home, &base)?;
        let pem = read_private(&key, 8192)?.ok_or(())?;
        let id = read_private(&sidecar(&key, ".device-id"), 128)?.ok_or(())?;
        signed_session_proof(&pem, id.trim(), "ABCDEFGHIJKLMNOPQRSTUVWX").map_err(|_| ())?;
        rca_native_agent::secure_input_cli::run_secure_input_owner_flow(
            &current.endpoint,
            &pem,
            id.trim(),
            request_id,
        )
        .map_err(|_| ())
    }

    fn public_help() {
        println!("Usage: rca [status [--json]|doctor [--json]|logs|start|stop|restart|pair|recover|uninstall|secure-input REQUEST_ID|--version|--help]");
        println!("Use the reviewed installer for installation and upgrade. Use pair to reconcile the existing approved identity. Automatic update commands are not yet available.");
    }

    fn interactive_menu() -> Result<Option<String>, ()> {
        use std::io::{IsTerminal, Write};
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            eprintln!(
                "Interactive menu requires a local terminal; use rca status --json or rca --help."
            );
            return Err(());
        }
        let actions = [
            "status",
            "doctor",
            "logs",
            "start",
            "stop",
            "restart",
            "pair",
            "recover",
            "uninstall",
        ];
        for (index, action) in actions.iter().enumerate() {
            println!("{}. {action}", index + 1);
        }
        println!("0. Exit");
        print!("Select an action: ");
        std::io::stdout().flush().map_err(|_| ())?;
        let mut choice = String::new();
        if std::io::stdin().read_line(&mut choice).map_err(|_| ())? == 0
            || matches!(choice.trim(), "" | "0")
        {
            return Ok(None);
        }
        let index = choice
            .trim()
            .parse::<usize>()
            .map_err(|_| ())?
            .checked_sub(1)
            .ok_or(())?;
        Ok(Some(actions.get(index).ok_or(())?.to_string()))
    }

    pub fn run() -> Result<(), ()> {
        native_host()?;
        let mut arguments: Vec<String> = std::env::args_os()
            .skip(1)
            .map(|value| value.into_string().map_err(|_| ()))
            .collect::<Result<_, _>>()?;
        if arguments.is_empty() {
            let Some(action) = interactive_menu()? else {
                return Ok(());
            };
            arguments.push(action);
        }
        if let [action] = arguments.as_slice() {
            if action == "--help" {
                public_help();
                return Ok(());
            }
            if matches!(action.as_str(), "version" | "--version") {
                let package = darwin_package::verify(&current_bundle()?, native_target())?;
                println!("{}", package.version);
                return Ok(());
            }
            if action == "uninstall" {
                return uninstall_local();
            }
            if action == "recover" {
                return recover_switch();
            }
            if action == "pair" {
                return reconcile_installed_pair();
            }
            if action == "restart" {
                return restart_local();
            }
            if matches!(action.as_str(), "status" | "doctor" | "logs") {
                return diagnose(action, false);
            }
            if matches!(action.as_str(), "stop" | "start") {
                return manage(action);
            }
        }
        if let [action, request_id] = arguments.as_slice() {
            if matches!(action.as_str(), "status" | "doctor") && request_id == "--json" {
                return diagnose(action, true);
            }
            if action == "secure-input" {
                return secure_input_local(request_id);
            }
        }
        if let [action, endpoint, name, version, source] = arguments.as_slice() {
            if action == "--install-local" {
                return install_local(endpoint, name, version, source);
            }
        }
        if let [action, endpoint, version, source] = arguments.as_slice() {
            if action == "--upgrade-local" {
                return upgrade_local(endpoint, version, source);
            }
        }
        if let [action, endpoint, name] = arguments.as_slice() {
            if action == "--verify-bundle" {
                let package = darwin_package::verify(&current_bundle()?, native_target())?;
                if package.version != *endpoint || package.target != *name {
                    return Err(());
                }
                println!("{}", package.source);
                return Ok(());
            }
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
        let marker_failed = Arc::new(AtomicBool::new(false));
        let result = if let Some(generation) = generation {
            let marker_identity = key.parent().ok_or(())?.to_path_buf();
            let marker_generation = generation.to_owned();
            let version = std::env::current_exe()
                .ok()
                .as_deref()
                .and_then(rca_native_agent::installed_version);
            let callback = |connected| {
                let identity = marker_identity.clone();
                let generation = marker_generation.clone();
                let version = version.clone();
                let stop = Arc::clone(&stop);
                let marker_failed = Arc::clone(&marker_failed);
                Arc::new(move || {
                    if record_connection(&identity, &generation, version.as_deref(), connected)
                        .is_err()
                    {
                        marker_failed.store(true, Ordering::Release);
                        stop.store(true, Ordering::Release);
                    }
                }) as Arc<dyn Fn() + Send + Sync>
            };
            run_native_managed_session_with_upgrade(
                endpoint,
                &private_pem,
                device_id,
                &receipts,
                managed,
                &stop,
                UpgradeRuntimeOptions {
                    on_disconnected: Some(callback(false)),
                    on_diagnostic: None,
                    key_path: key,
                    on_connected: Some(callback(true)),
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
        if marker_failed.load(Ordering::Acquire) {
            return Err(());
        }
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

// A fork in an unrelated test can retain the open file description until
// exec despite CLOEXEC, delaying flock release. Serialize only the fixture
// that spawns children and the fixture that asserts immediate lock handoff.
#[cfg(all(test, unix))]
static LOCK_HANDOFF_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(all(test, unix))]
mod pairing_admission_tests {
    use super::pairing_store;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn permanent_and_temporary_paths_are_separate_and_serialized() {
        let _fixture = super::LOCK_HANDOFF_TEST.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        fs::set_permissions(home, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(super::identity_directory(home, false).is_err());
        assert!(!home.join(".local").exists());
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

#[cfg(all(test, unix))]
mod connection_marker_tests {
    use super::record_connection;
    use std::fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

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
        record_connection(dir.path(), "candidate-generation", Some("v0.1.60"), true).unwrap();
        let raw = fs::read_to_string(&marker).unwrap();
        assert!(raw.ends_with('\n'));
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["state"], "connected");
        assert_eq!(value["generation"], "candidate-generation");
        assert!(value["at"].as_u64().is_some());
        assert_eq!(value["version"], "v0.1.60");
        assert_eq!(value["pid"], std::process::id());
        record_connection(dir.path(), "candidate-generation", Some("v0.1.60"), false).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(value["state"], "disconnected");
        assert_eq!(value["version"], "v0.1.60");
        record_connection(dir.path(), "candidate-generation", None, true).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        assert!(value["version"].is_null());
        assert_eq!(value["state"], "connected");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        assert_eq!(
            fs::symlink_metadata(&marker).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(&marker).unwrap();
        let foreign = dir.path().join("foreign");
        fs::write(&foreign, b"unrelated").unwrap();
        std::os::unix::fs::symlink(&foreign, &marker).unwrap();
        assert!(record_connection(dir.path(), "candidate-generation", None, false).is_err());
        assert_eq!(fs::read(foreign).unwrap(), b"unrelated");
    }
}
