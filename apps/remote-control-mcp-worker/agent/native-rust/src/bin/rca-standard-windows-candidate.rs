//! Unshipped Standard Windows RCA entrypoint: owner-local pairing, existing
//! private identity, and explicit same-owner service launch contract.
#[cfg(windows)]
mod windows {
    use rca_native_agent::automatic_update::{automatic_jitter, AutomaticCheckSchedule};
    use rca_native_agent::identity::{signed_session_proof, valid_device_id};
    use rca_native_agent::native_file::{
        run_native_managed_session_with_upgrade, NativeFileError, UpgradeRuntimeOptions,
    };
    use rca_native_agent::session::SessionError;
    use rca_native_agent::validate_windows_private_path;
    use rca_native_agent::windows_log;
    use rca_native_agent::windows_managed::WindowsManagedSessions;
    use std::fs;
    use std::io::{ErrorKind, IsTerminal, Read, Write};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT,
    };
    static SIGNAL_STOP: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn request_stop(event: u32) -> i32 {
        if event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT {
            SIGNAL_STOP.store(true, Ordering::Release);
            return 1;
        }
        0
    }

    fn store_root() -> Result<PathBuf, ()> {
        let base = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or(())?);
        if !base.is_absolute() {
            return Err(());
        }
        Ok(base.join("mcp-workers").join("remote-control"))
    }

    fn key_path(root: &Path) -> Result<PathBuf, ()> {
        if let Some(value) = std::env::var_os("REMOTE_CONTROL_AGENT_KEY_PATH") {
            let path = PathBuf::from(value);
            return path.is_absolute().then_some(path).ok_or(());
        }
        Ok(root.join("v2-identity.pem"))
    }

    fn read_private(path: &Path, max: u64) -> Result<Vec<u8>, ()> {
        let meta = fs::symlink_metadata(path).map_err(|_| ())?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 || meta.len() > max {
            return Err(());
        }
        validate_windows_private_path(path, false).map_err(|_| ())?;
        fs::read(path).map_err(|_| ())
    }

    fn optional_private(path: &Path, max: u64) -> Result<Option<Vec<u8>>, ()> {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
            Ok(_) => read_private(path, max).map(Some),
        }
    }

    // The service and management CLI use the same identity parser. Status
    // neither creates state nor requests authorization or a network connection.
    fn local_identity(key: &Path) -> Result<(Option<String>, Option<String>), ()> {
        let pem = optional_private(key, 8192)?
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| ())?;
        let id_path = PathBuf::from(format!("{}.device-id", key.display()));
        let id = optional_private(&id_path, 256)?
            .map(String::from_utf8)
            .transpose()
            .map_err(|_| ())?
            .map(|value| value.trim().to_owned());
        match (&pem, &id) {
            (Some(pem), Some(id)) => {
                signed_session_proof(pem, id, "000000000000000000000000").map_err(|_| ())?;
            }
            (None, Some(_)) => return Err(()),
            _ => {}
        }
        Ok((pem, id))
    }

    fn local_status_facts() -> Result<serde_json::Value, ()> {
        let root = store_root()?;
        match fs::symlink_metadata(&root) {
            Ok(_) => validate_windows_private_path(&root, true).map_err(|_| ())?,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(()),
        }
        let (pem, id) = local_identity(&root.join("v2-identity.pem"))?;
        let policy = match id.as_deref() {
            Some(id)
                if optional_private(&root.join("v2-identity.pem.install-mode"), 32)?.as_deref()
                    == Some(b"permanent\n") =>
            {
                rca_native_agent::device_pairing::windows_auto_policy(&root, id)
            }
            _ => "off",
        };
        let task = program_root()
            .ok()
            .and_then(|(directory, _)| task_command(&directory, &["-Action", "Status"]).ok())
            .and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok());
        let activity = task
            .as_ref()
            .and_then(|value| value["automatic_update_activity"].as_str());
        let activity = match (activity, policy) {
            (Some("needs_attention"), _) => "needs_attention",
            (Some("upgrading"), _) => "upgrading",
            (Some("unknown"), _) | (_, "unknown") => "unknown",
            (Some("waiting_idle"), "off") => "disabled",
            (Some(value), _) => value,
            (_, "off") => "disabled",
            _ => "unknown",
        };
        Ok(serde_json::json!({
            "platform": "win32",
            "mode": "native-user-agent",
            "identity_present": pem.is_some(),
            "device_id": id,
            "remote_connection": "unconfirmed",
            "automatic_update": policy,
            "automatic_update_activity": activity,
            "automatic_update_result": task.as_ref().map(|value| &value["automatic_update_result"]),
            "installed_version": task.as_ref().and_then(|value| value["version"].as_str()),
            "shell": true,
            "write_file": true
        }))
    }

    fn local_status(doctor: bool) -> Result<(), ()> {
        let state = local_status_facts()?;
        if doctor {
            let mut findings = Vec::new();
            if state["identity_present"] == false || state["device_id"].is_null() {
                findings.push("local_identity_unconfirmed");
            }
            findings.extend([
                "local_service_unconfirmed",
                "cloud_authorization_unconfirmed",
                "signed_wss_unconfirmed",
            ]);
            println!(
                "{}",
                serde_json::json!({"status": state, "findings": findings})
            );
        } else {
            println!("{state}");
        }
        Ok(())
    }

    fn stopped(key: &Path) -> Result<bool, ()> {
        let marker = PathBuf::from(format!("{}.owner-stopped", key.display()));
        match fs::symlink_metadata(&marker) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(_) => Err(()),
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                validate_windows_private_path(&marker, false).map_err(|_| ())?;
                Ok(true)
            }
            Ok(_) => Err(()),
        }
    }

    // Same header compatibility boundary as the Linux handoff. Only called
    // after the previous Agent has exited; never open a second SQLite writer.
    fn verify_upgrade_state() -> Result<(), ()> {
        let root = store_root()?;
        validate_windows_private_path(&root, true).map_err(|_| ())?;
        let key = root.join("v2-identity.pem");
        let (pem, id) = local_identity(&key)?;
        if pem.is_none() || id.is_none() || stopped(&key)? {
            return Err(());
        }
        let directory = root.join("receipts");
        validate_windows_private_path(&directory, true).map_err(|_| ())?;
        let db = directory.join("operation-receipts.sqlite");
        match fs::symlink_metadata(&db) {
            Err(error) if error.kind() == ErrorKind::NotFound => {
                for name in [
                    "operation-receipts.json",
                    "operation-receipts.pre-sqlite.json",
                ] {
                    match fs::symlink_metadata(directory.join(name)) {
                        Err(error) if error.kind() == ErrorKind::NotFound => {}
                        _ => return Err(()),
                    }
                }
            }
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                validate_windows_private_path(&db, false).map_err(|_| ())?;
                let mut header = [0u8; 100];
                fs::File::open(&db)
                    .map_err(|_| ())?
                    .read_exact(&mut header)
                    .map_err(|_| ())?;
                if &header[..16] != b"SQLite format 3\0"
                    || !matches!(
                        u32::from_be_bytes(header[60..64].try_into().map_err(|_| ())?),
                        0 | 1
                    )
                {
                    return Err(());
                }
            }
            _ => return Err(()),
        }
        Ok(())
    }

    // Evidence of a handshake, not present network liveness. The task
    // controller additionally verifies the actual process and generation.
    fn activation_proof(generation: &str) -> Result<(), ()> {
        if !valid_device_id(generation) {
            return Err(());
        }
        let root = store_root()?;
        validate_windows_private_path(&root, true).map_err(|_| ())?;
        let (_, id) = local_identity(&root.join("v2-identity.pem"))?;
        let id = id.ok_or(())?;
        let path = root.join(format!(".windows-connected-{generation}.json"));
        let proof: serde_json::Value =
            serde_json::from_slice(&read_private(&path, 4096)?).map_err(|_| ())?;
        if proof["generation"].as_str() != Some(generation)
            || proof["device_id"].as_str() != Some(id.as_str())
            || proof["state"].as_str() != Some("connected")
            || !matches!(proof["pid"].as_u64(), Some(pid) if pid > 0 && pid <= u64::from(u32::MAX))
            || !matches!(proof["at"].as_u64(), Some(at) if at > 0)
        {
            return Err(());
        }
        println!(
            "{}",
            serde_json::json!({
                "generation": generation,
                "device_id": id,
                "state": "connected",
                "pid": proof["pid"],
                "at": proof["at"],
            })
        );
        Ok(())
    }

    fn record_connected(root: &Path, generation: &str, device_id: &str) -> Result<(), ()> {
        let path = root.join(format!(".windows-connected-{generation}.json"));
        let record = serde_json::json!({
            "generation": generation,
            "device_id": device_id,
            "pid": std::process::id(),
            "state": "connected",
            "at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).map_err(|_| ())?.as_millis()
        });
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| ())?;
        file.write_all(record.to_string().as_bytes())
            .map_err(|_| ())?;
        file.write_all(b"\n").map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        validate_windows_private_path(&path, false).map_err(|_| ())?;
        Ok(())
    }

    fn pair_local(endpoint: &str, name: &str, mode: &str) -> Result<(), ()> {
        use rca_native_agent::device_pairing::{pair_windows_identity, PairingClient};
        if !std::io::stdin().is_terminal()
            || !std::io::stdout().is_terminal()
            || name.is_empty()
            || name.encode_utf16().count() > 64
            || name.chars().any(|c| c < '\u{20}')
        {
            return Err(());
        }
        let temporary = match mode {
            "permanent" => false,
            "temporary" => true,
            _ => return Err(()),
        };
        let client = PairingClient::new(endpoint).map_err(|_| ())?;
        let root = store_root()?;
        pair_windows_identity(&root, &client, name, temporary, |pending| {
            println!("{}", client.approval_instruction(pending, mode));
        })
        .map_err(|_| ())?;
        println!("Approved identity recovered; foreground and Task activation are separate.");
        Ok(())
    }

    fn approved_identity(
        endpoint: &str,
        temporary: bool,
        initial: bool,
    ) -> Result<(PathBuf, String, String), ()> {
        use rca_native_agent::device_pairing::PairingClient;
        let root = store_root()?;
        validate_windows_private_path(&root, true).map_err(|_| ())?;
        let key = root.join("v2-identity.pem");
        let expected = if temporary {
            b"temporary\n".as_slice()
        } else {
            b"permanent\n".as_slice()
        };
        if stopped(&key)?
            || read_private(&root.join("v2-identity.pem.install-mode"), 32)? != expected
            || optional_private(&root.join("windows-native-upgrade.json"), 4096)?.is_some()
            || optional_private(&root.join("v2-identity.pem.device-id.pending"), 128)?.is_some()
        {
            return Err(());
        }
        let (pem, id) = local_identity(&key)?;
        let pem = pem.ok_or(())?;
        let id = id.ok_or(())?;
        let pending = optional_private(&root.join("v2-identity.pem.activation-pending"), 128)?;
        if ((temporary || !initial) && pending.is_some())
            || (initial && pending.as_deref() != Some(format!("{id}\n").as_bytes()))
        {
            return Err(());
        }
        let client = PairingClient::new(endpoint).map_err(|_| ())?;
        client.recover(&pem, Some(&id)).map_err(|_| ())?;
        if !temporary {
            client.verify_permanent_grant(&id).map_err(|_| ())?;
        }
        Ok((key, pem, id))
    }

    fn program_root() -> Result<(PathBuf, String), ()> {
        let executable = std::env::current_exe().map_err(|_| ())?;
        let directory = executable.ancestors().nth(4).ok_or(())?.to_path_buf();
        let root = store_root()?.join("programs");
        let name = directory
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(())?;
        let tag = name.strip_suffix("-windows-x64").ok_or(())?.to_owned();
        validate_windows_private_path(&directory, true).map_err(|_| ())?;
        if fs::canonicalize(directory.parent().ok_or(())?).map_err(|_| ())?
            != fs::canonicalize(root).map_err(|_| ())?
            || !tag.starts_with('v')
        {
            return Err(());
        }
        Ok((directory, tag))
    }

    fn task_command(directory: &Path, args: &[&str]) -> Result<std::process::Output, ()> {
        owner_script_command(directory, "windows-user-task.ps1", args)
    }

    fn owner_script_command(
        directory: &Path,
        script_name: &str,
        args: &[&str],
    ) -> Result<std::process::Output, ()> {
        let system = PathBuf::from(std::env::var_os("SystemRoot").ok_or(())?);
        if !system.is_absolute() {
            return Err(());
        }
        let script = directory
            .join("apps/remote-control-agent/scripts")
            .join(script_name);
        validate_windows_private_path(&script, false).map_err(|_| ())?;
        let output = Command::new(system.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .args(args)
            .output()
            .map_err(|_| ())?;
        if !output.status.success() {
            eprintln!("Windows Task action refused; review retained owner state.");
            return Err(());
        }
        Ok(output)
    }

    fn automatic_policy(action: Option<&str>) -> Result<(), ()> {
        use rca_native_agent::device_pairing::{
            lock_windows_permanent_mode, persist_windows_auto_policy, windows_auto_policy,
        };
        let (directory, _) = program_root()?;
        let root = store_root()?;
        if optional_private(&root.join("v2-identity.pem.install-mode"), 32)?.as_deref()
            != Some(b"permanent\n")
        {
            return Err(());
        }
        let _guard = if action.is_some() {
            Some(lock_windows_permanent_mode(&root).map_err(|_| ())?)
        } else {
            None
        };
        let (_, id) = local_identity(&root.join("v2-identity.pem"))?;
        let id = id.ok_or(())?;
        let status = task_command(&directory, &["-Action", "Status"])?;
        let facts: serde_json::Value = serde_json::from_slice(&status.stdout).map_err(|_| ())?;
        if facts["installed"] != true {
            return Err(());
        }
        if let Some(action) = action {
            if action == "on" || action == "initialize" {
                let tag = facts["version"].as_str().ok_or(())?;
                let parts: Vec<_> = tag.strip_prefix('v').ok_or(())?.split('.').collect();
                if parts.len() != 3
                    || parts.iter().any(|part| {
                        part.is_empty()
                            || !part.bytes().all(|b| b.is_ascii_digit())
                            || (part.len() > 1 && part.starts_with('0'))
                    })
                {
                    return Err(());
                }
                for name in [
                    "windows-native-upgrade.json",
                    "v2-identity.pem.activation-pending",
                    "v2-identity.pem.device-id.pending",
                ] {
                    if optional_private(&root.join(name), 4096)?.is_some() {
                        return Err(());
                    }
                }
            }
            // The installer default may only create missing consent, never
            // replace a policy the owner has already explicitly selected.
            if action != "initialize"
                || optional_private(&root.join("v2-identity.pem.automatic-update"), 256)?.is_none()
            {
                persist_windows_auto_policy(&root, &id, action != "off").map_err(|_| ())?;
            }
        }
        let policy = windows_auto_policy(&root, &id);
        println!("{}", serde_json::json!({"automatic_update":policy}));
        if action.is_some_and(|expected| {
            policy == "unknown" || (expected != "initialize" && expected != policy)
        }) {
            return Err(());
        }
        Ok(())
    }

    fn check_latest() -> Result<(), ()> {
        let (directory, _) = program_root()?;
        let status = task_command(&directory, &["-Action", "Status"])?;
        let facts: serde_json::Value = serde_json::from_slice(&status.stdout).map_err(|_| ())?;
        if facts["installed"] != true {
            return Err(());
        }
        let installed = facts["version"].as_str().ok_or(())?;
        let observed = owner_script_command(
            &directory,
            "windows-stage-install.ps1",
            &["-CheckOnly", "-Version", installed],
        )?;
        let result: serde_json::Value = serde_json::from_slice(&observed.stdout).map_err(|_| ())?;
        if result["installed_version"] != installed {
            return Err(());
        }
        println!("{result}");
        if result["status"] == "unknown" {
            return Err(());
        }
        Ok(())
    }

    fn foreground(endpoint: &str) -> Result<(), ()> {
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(());
        }
        let (directory, _) = program_root()?;
        let status = task_command(&directory, &["-Action", "Status"])?;
        let state: serde_json::Value = serde_json::from_slice(&status.stdout).map_err(|_| ())?;
        if state["installed"] != false {
            return Err(());
        }
        let (key, pem, id) = approved_identity(endpoint, true, false)?;
        run_agent(endpoint, &key, &pem, &id, None)
    }

    fn repair_local(endpoint: &str, name: &str) -> Result<(), ()> {
        use rca_native_agent::device_pairing::{repair_windows_identity, PairingClient};
        use rca_native_agent::session_recovery::SessionRecoveryError;
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(());
        }
        let (directory, _) = program_root()?;
        let root = store_root()?;
        let client = PairingClient::new(endpoint).map_err(|_| ())?;
        repair_windows_identity(
            &root,
            &client,
            name,
            || {
                let checked = || -> Result<(), ()> {
                    task_command(
                        &directory,
                        &["-Action", "ConfirmStopped", "-Endpoint", endpoint],
                    )?;
                    Ok(())
                };
                checked().map_err(|_| SessionRecoveryError::InvalidIdentity)
            },
            |pending| {
                println!("{}", client.approval_instruction(pending, "permanent"));
            },
        )
        .map_err(|_| ())?;
        println!(
            "Signed authorization confirmed; original private key retained. Task remains stopped."
        );
        Ok(())
    }

    /// Same-version installer reconciliation. Healthy signed identity is a
    /// no-op. Only a confirmed missing grant or signed same-key ID change
    /// permits stopping the Task and asking for attended recovery.
    fn reconcile_existing(endpoint: &str) -> Result<(), ()> {
        use rca_native_agent::device_pairing::PairingClient;
        use rca_native_agent::session_recovery::SessionRecoveryError;
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(());
        }
        let (directory, _) = program_root()?;
        let root = store_root()?;
        let key = root.join("v2-identity.pem");
        if stopped(&key)? {
            println!("Owner STOP preserved.");
            return Ok(());
        }
        if read_private(&root.join("v2-identity.pem.install-mode"), 32)? != b"permanent\n"
            || optional_private(&root.join("windows-native-upgrade.json"), 4096)?.is_some()
            || optional_private(&root.join("v2-identity.pem.activation-pending"), 128)?.is_some()
        {
            return Err(());
        }
        let (pem, id) = local_identity(&key)?;
        let pem = pem.ok_or(())?;
        let id = id.ok_or(())?;
        let output = task_command(&directory, &["-Action", "Endpoint"])?;
        if std::str::from_utf8(&output.stdout).map_err(|_| ())?.trim() != endpoint {
            return Err(());
        }
        let client = PairingClient::new(endpoint).map_err(|_| ())?;
        let pending = optional_private(&root.join("v2-identity.pem.device-id.pending"), 128)?;
        match client.recover(&pem, None) {
            Ok(approved) if approved == id && pending.is_none() => {
                println!("Approved identity unchanged; no Task modification.");
                return Ok(());
            }
            Ok(_) | Err(SessionRecoveryError::Pending) => {}
            Err(_) => return Err(()),
        }
        let status = task_command(&directory, &["-Action", "Status"])?;
        let state: serde_json::Value = serde_json::from_slice(&status.stdout).map_err(|_| ())?;
        if state["installed"] != true {
            return Err(());
        }
        if state["running"] == true {
            task_command(&directory, &["-Action", "Stop"])?;
        }
        let name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows".to_owned());
        repair_local(endpoint, &name)?;
        // Old Node installer contract: successful reauthorization requests
        // Start, but does not claim signed WSS activation.
        if stopped(&key)? {
            return Err(());
        }
        task_command(
            &directory,
            &["-Action", "ConfirmStopped", "-Endpoint", endpoint],
        )?;
        task_command(&directory, &["-Action", "Start"])?;
        println!("Authorization restored; Task start requested, connection unconfirmed.");
        Ok(())
    }

    fn owner_lifecycle(resume: bool) -> Result<(), ()> {
        use rca_native_agent::device_pairing::{
            lock_windows_permanent_mode, persist_windows_owner_stop, PairingClient,
        };
        if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
            return Err(());
        }
        let (directory, _) = program_root()?;
        let root = store_root()?;
        let _guard = lock_windows_permanent_mode(&root).map_err(|_| ())?;
        for name in [
            "windows-native-upgrade.json",
            "v2-identity.pem.activation-pending",
            "v2-identity.pem.device-id.pending",
        ] {
            if optional_private(&root.join(name), 4096)?.is_some() {
                return Err(());
            }
        }
        let (pem, id) = local_identity(&root.join("v2-identity.pem"))?;
        let pem = pem.ok_or(())?;
        let id = id.ok_or(())?;
        let output = task_command(&directory, &["-Action", "Endpoint"])?;
        let endpoint = std::str::from_utf8(&output.stdout).map_err(|_| ())?.trim();
        let client = PairingClient::new(endpoint).map_err(|_| ())?;
        let marker = root.join("v2-identity.pem.owner-stopped");
        let saved = optional_private(&marker, 32)?;
        if saved.as_ref().is_some_and(|value| value != b"stopped\n") {
            return Err(());
        }
        if !resume {
            persist_windows_owner_stop(&root).map_err(|_| ())?;
            let cloud = if client.owner_intent(&pem, &id, "stop").is_ok() {
                "confirmed"
            } else {
                "unconfirmed"
            };
            task_command(&directory, &["-Action", "Stop"])?;
            let status = task_command(&directory, &["-Action", "Status"])?;
            let state: serde_json::Value =
                serde_json::from_slice(&status.stdout).map_err(|_| ())?;
            if state["installed"] != true || state["running"] != false {
                return Err(());
            }
            println!(
                "{}",
                serde_json::json!({"local":"task_stopped","cloud":cloud})
            );
            return Ok(());
        }
        if saved.is_none() {
            return Err(());
        }
        // Reconfirm STOP first, including an earlier offline Stop. Never
        // remove the durable intent on a lost or rejected Resume response.
        client.owner_intent(&pem, &id, "stop").map_err(|_| ())?;
        client.owner_intent(&pem, &id, "resume").map_err(|_| ())?;
        fs::remove_file(&marker).map_err(|_| ())?;
        if task_command(&directory, &["-Action", "Start"]).is_err() {
            persist_windows_owner_stop(&root).map_err(|_| ())?;
            return Err(());
        }
        println!(
            "{}",
            serde_json::json!({"local":"start_requested","cloud":"resume_pending_signed_WSS"})
        );
        Ok(())
    }

    pub fn run() -> Result<(), ()> {
        if !cfg!(target_arch = "x86_64")
            || rca_native_agent::is_windows_system_identity().map_err(|_| ())?
        {
            return Err(());
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        if let [command, endpoint, name, mode] = args.as_slice() {
            if command == "--pair-local" {
                return pair_local(endpoint, name, mode);
            }
        }
        if args.as_slice() == ["--initialize-auto-policy"] {
            return automatic_policy(Some("initialize"));
        }
        if args.as_slice() == ["--verify-upgrade-state"] {
            return verify_upgrade_state();
        }
        if args.first().map(String::as_str) == Some("--cli") {
            return match args.as_slice() {
                [_, command] if command == "--help" || command == "help" => {
                    println!("Usage: rca [status [--json]|doctor [--json]|logs|start|stop|update [--check|--auto [on|off]|--version <staged-tag>]|recover|--version|--help]");
                    println!("Bare update or upgrade uses the packaged owner installer from rca.cmd. Use the official installer for initial installation.");
                    Ok(())
                }
                [_, command] if command == "status" || command == "doctor" => {
                    local_status(command == "doctor")
                }
                [_, command, flag]
                    if (command == "status" || command == "doctor") && flag == "--json" =>
                {
                    local_status(command == "doctor")
                }
                [_, command] if command == "logs" => {
                    print!(
                        "{}",
                        windows_log::read_events(&store_root()?).map_err(|_| ())?
                    );
                    Ok(())
                }
                [_, command] if command == "stop" => owner_lifecycle(false),
                [_, command] if command == "start" => owner_lifecycle(true),
                [_, command, flag, endpoint] if command == "re-pair" && flag == "--endpoint" => {
                    let name =
                        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows".to_owned());
                    repair_local(endpoint, &name)
                }
                [_, command, flag, endpoint] if command == "onboard" && flag == "--endpoint" => {
                    reconcile_existing(endpoint)
                }
                [_, command, flag, endpoint] if command == "enable" && flag == "--endpoint" => {
                    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
                        return Err(());
                    }
                    let (directory, tag) = program_root()?;
                    let output = task_command(
                        &directory,
                        &[
                            "-Action",
                            "EnableNative",
                            "-Version",
                            &tag,
                            "-Endpoint",
                            endpoint,
                        ],
                    )?;
                    print!("{}", String::from_utf8_lossy(&output.stdout));
                    Ok(())
                }
                [_, command, flag]
                    if (command == "upgrade" || command == "update") && flag == "--auto" =>
                {
                    automatic_policy(None)
                }
                [_, command, flag, action]
                    if (command == "upgrade" || command == "update")
                        && flag == "--auto"
                        && (action == "on" || action == "off") =>
                {
                    automatic_policy(Some(action))
                }
                [_, command, flag]
                    if (command == "upgrade" || command == "update") && flag == "--check" =>
                {
                    check_latest()
                }
                [_, command, flag, version]
                    if (command == "upgrade" || command == "update") && flag == "--version" =>
                {
                    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
                        return Err(());
                    }
                    let (directory, _) = program_root()?;
                    let output = task_command(
                        &directory,
                        &[
                            "-Action",
                            "Switch",
                            "-Direction",
                            "Upgrade",
                            "-Version",
                            version,
                        ],
                    )?;
                    print!("{}", String::from_utf8_lossy(&output.stdout));
                    Ok(())
                }
                [_, command] if command == "recover" => {
                    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
                        return Err(());
                    }
                    let (directory, _) = program_root()?;
                    let output = task_command(&directory, &["-Action", "RecoverNativeUpgrade"])?;
                    print!("{}", String::from_utf8_lossy(&output.stdout));
                    Ok(())
                }
                [_, command] if command == "task-status" => {
                    let (directory, _) = program_root()?;
                    let output = task_command(&directory, &["-Action", "Status"])?;
                    print!("{}", String::from_utf8_lossy(&output.stdout));
                    Ok(())
                }
                [_, command] if command == "disable" => {
                    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
                        return Err(());
                    }
                    let (directory, _) = program_root()?;
                    let output = task_command(&directory, &["-Action", "Disable"])?;
                    print!("{}", String::from_utf8_lossy(&output.stdout));
                    Ok(())
                }
                [_, command] if command == "version" || command == "--version" => {
                    let (_, tag) = program_root()?;
                    println!("{tag}");
                    Ok(())
                }
                [_, command, flag, endpoint] if command == "run" && flag == "--endpoint" => {
                    foreground(endpoint)
                }
                _ => Err(()),
            };
        }
        if let [command, generation] = args.as_slice() {
            if command == "--verify-activation-proof" {
                return activation_proof(generation);
            }
            if command == "--verify-enable-pairing" {
                let (_, _, id) = approved_identity(generation, false, false)?;
                println!("{}", serde_json::json!({"device_id":id}));
                return Ok(());
            }
            if command == "--verify-initial-pairing" {
                let (_, _, id) = approved_identity(generation, false, true)?;
                println!("{}", serde_json::json!({"device_id":id}));
                return Ok(());
            }
        }
        let [mode, endpoint_flag, endpoint, generation_flag, generation] = args.as_slice() else {
            return Err(());
        };
        if mode != "--service"
            || endpoint_flag != "--endpoint"
            || generation_flag != "--generation"
            || !valid_device_id(generation)
            || !(endpoint.starts_with("https://")
                && endpoint.ends_with('/')
                && endpoint[8..endpoint.len() - 1]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':')))
        {
            return Err(());
        }
        let root = store_root()?;
        let key = key_path(&root)?;
        if !key.starts_with(&root) {
            return Err(());
        }
        // Owner STOP preserves the existing behavior even if the ID is missing.
        if stopped(&key)? {
            read_private(&key, 8192)?;
            windows_log::record(&root, "owner_stopped");
            return Ok(());
        }
        let (pem, id) = local_identity(&key)?;
        let id = id.ok_or(())?;
        let private_pem = pem.ok_or(())?;
        if optional_private(&root.join("v2-identity.pem.install-mode"), 32)?
            .is_some_and(|mode| mode != b"permanent\n")
        {
            return Err(());
        }
        run_agent(endpoint, &key, &private_pem, &id, Some(generation))
    }

    fn automatic_installer(root: &Path, key: &Path) -> Option<(PathBuf, PathBuf)> {
        if key != root.join("v2-identity.pem") {
            return None;
        }
        let (directory, tag) = program_root().ok()?;
        let parts = tag.strip_prefix('v')?.split('.').collect::<Vec<_>>();
        if parts.len() != 3
            || parts.iter().any(|part| {
                part.is_empty()
                    || !part.bytes().all(|b| b.is_ascii_digit())
                    || (part.len() > 1 && part.starts_with('0'))
            })
        {
            return None;
        }
        let installer =
            directory.join("apps/remote-control-agent/scripts/windows-stage-install.ps1");
        validate_windows_private_path(&installer, false).ok()?;
        let system = PathBuf::from(std::env::var_os("SystemRoot")?);
        if !system.is_absolute() {
            return None;
        }
        Some((
            system.join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            installer,
        ))
    }

    fn automatic_monitor(
        root: PathBuf,
        device_id: String,
        stop: Arc<AtomicBool>,
        powershell: PathBuf,
        installer: PathBuf,
    ) {
        let mut schedule = AutomaticCheckSchedule::new(Instant::now(), automatic_jitter(240));
        let mut checker: Option<std::process::Child> = None;
        while !stop.load(Ordering::Acquire) {
            if let Some(child) = checker.as_mut() {
                match child.try_wait() {
                    Ok(None) => (),
                    Ok(Some(status)) => {
                        if !status.success() {
                            windows_log::record(&root, "automatic_check_refused");
                        }
                        checker = None;
                    }
                    Err(_) => {
                        checker = None;
                        windows_log::record(&root, "automatic_check_unconfirmed");
                    }
                }
            }
            let now = Instant::now();
            if checker.is_none()
                && schedule.is_due(now)
                && schedule.take_due(now, automatic_jitter(1800))
                && rca_native_agent::device_pairing::windows_auto_policy(&root, &device_id) == "on"
            {
                // The packaged manager revalidates permanent identity, live signed
                // connection, policy and the exact installed Task. It only submits
                // the existing demand-start owner upgrade Task; never blocks WSS.
                match Command::new(&powershell)
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                    ])
                    .arg(&installer)
                    .arg("-Automatic")
                    .env_remove("RCA_UNATTENDED_UPGRADE")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                {
                    Ok(child) => checker = Some(child),
                    Err(_) => windows_log::record(&root, "automatic_check_launch_failed"),
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn run_agent(
        endpoint: &str,
        key: &Path,
        private_pem: &str,
        device_id: &str,
        generation: Option<&str>,
    ) -> Result<(), ()> {
        let root = store_root()?;
        let receipts = root.join("receipts");
        let meta = fs::symlink_metadata(&receipts).map_err(|_| ())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(());
        }
        validate_windows_private_path(&receipts, true).map_err(|_| ())?;
        let managed =
            Arc::new(WindowsManagedSessions::new(Duration::from_secs(60 * 60)).map_err(|_| ())?);
        let stop = Arc::new(AtomicBool::new(false));
        let monitor = if generation.is_none() {
            if unsafe { SetConsoleCtrlHandler(Some(request_stop), 1) } == 0 {
                return Err(());
            }
            let flag = Arc::clone(&stop);
            Some(std::thread::spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    if SIGNAL_STOP.load(Ordering::Acquire) {
                        flag.store(true, Ordering::Release);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }))
        } else if let Some((powershell, installer)) = automatic_installer(&root, key) {
            let monitor_root = root.clone();
            let monitor_id = device_id.to_owned();
            let flag = Arc::clone(&stop);
            Some(std::thread::spawn(move || {
                automatic_monitor(monitor_root, monitor_id, flag, powershell, installer)
            }))
        } else {
            None
        };
        windows_log::record(&root, "starting");
        let marker_generation = generation.map(str::to_owned);
        let marker_id = device_id.to_owned();
        let connected_root = root.clone();
        let on_connected: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            windows_log::record(&connected_root, "connected");
            if let Some(generation) = marker_generation.as_deref() {
                let _ = record_connected(&connected_root, generation, &marker_id);
            }
        });
        let disconnected_root = root.clone();
        let on_disconnected: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            windows_log::record(&disconnected_root, "disconnected");
        });
        let diagnostic_root = root.clone();
        let outcome = run_native_managed_session_with_upgrade(
            endpoint,
            private_pem,
            device_id,
            &receipts,
            Arc::clone(&managed),
            &stop,
            UpgradeRuntimeOptions {
                key_path: key,
                on_connected: Some(on_connected),
                on_disconnected: Some(on_disconnected),
                on_diagnostic: Some(Arc::new(move |event| {
                    windows_log::record(&diagnostic_root, event)
                })),
            },
        );
        stop.store(true, Ordering::Release);
        if matches!(
            &outcome,
            Err(NativeFileError::Session(
                SessionError::Policy | SessionError::Rejected(_)
            ))
        ) {
            windows_log::record(&root, "rejected");
        }
        if let Err(error) = &outcome {
            if !matches!(error, NativeFileError::Session(_)) {
                windows_log::record(&root, error.diagnostic_event());
            }
        }
        windows_log::record(&root, "stopping");
        if let Some(monitor) = monitor {
            monitor.join().map_err(|_| ())?;
        }
        if managed.stop_all(Duration::from_secs(8))
            != rca_native_agent::windows_job::JobCleanup::Confirmed
        {
            return Err(());
        }
        match outcome {
            Ok(()) => Ok(()),
            Err(NativeFileError::Session(SessionError::Policy)) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

#[cfg(windows)]
fn main() {
    if windows::run().is_err() {
        eprintln!("Windows Rust candidate refused or session failed.");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows Rust candidate requires Windows x64.");
    std::process::exit(1);
}
