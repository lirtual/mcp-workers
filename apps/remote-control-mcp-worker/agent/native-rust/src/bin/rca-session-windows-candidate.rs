//! Unshipped GitHub-hosted Windows Session entrypoint for #914.
//! OIDC registration is one-shot; the managed-session child gets a minimal env.
#[cfg(windows)]
mod windows {
    use rca_native_agent::native_file::{run_native_managed_session, NativeFileError};
    use rca_native_agent::session_enrollment::load_or_create_windows_session_identity;
    use rca_native_agent::session_registration::{
        register_session_device, runner_oidc_token, RegisteredSessionDevice,
    };
    use rca_native_agent::session_transport_env::session_transport_environment;
    use rca_native_agent::windows_managed::WindowsManagedSessions;
    use rca_native_agent::windows_session_runner::{
        checked_runner_context, checked_transport_child_identity, record_candidate_stage,
        spawn_credential_free_transport, validate_transport_grant,
    };
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn source() -> Result<BTreeMap<String, String>, ()> {
        std::env::vars_os()
            .map(|(key, value)| {
                Ok((
                    key.into_string().map_err(|_| ())?,
                    value.into_string().map_err(|_| ())?,
                ))
            })
            .collect()
    }

    fn now_ms() -> Result<u64, ()> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ())?
            .as_millis()
            .try_into()
            .map_err(|_| ())
    }

    fn parent(source: &BTreeMap<String, String>) -> Result<(), ()> {
        let (attempt, runner_temp) = checked_runner_context(source).map_err(|_| ())?;
        let audience = source.get("WORKFLOW_ACTION_OIDC_AUDIENCE").ok_or(())?;
        let request_url = source.get("ACTIONS_ID_TOKEN_REQUEST_URL").ok_or(())?;
        let request_token = source.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN").ok_or(())?;
        let (_, identity) =
            load_or_create_windows_session_identity(&runner_temp, &attempt).map_err(|_| ())?;
        let jwt = runner_oidc_token(request_url, request_token, audience).map_err(|_| ())?;
        let grant = register_session_device(&identity, &jwt).map_err(|_| ())?;
        validate_transport_grant(&grant, now_ms()?).map_err(|_| ())?;
        // Signed Worker recovery is mandatory before any long-lived process.
        rca_native_agent::session_recovery::verify_registered_session_device(&identity, &grant)
            .map_err(|_| ())?;
        let executable = std::env::current_exe().map_err(|_| ())?;
        let _ = record_candidate_stage(source, "pending", true);
        let _child = spawn_credential_free_transport(&executable, &grant, &identity, source)
            .map_err(|_| ())?;
        println!("Session RCA Windows Candidate transport spawned after signed Worker recovery.");
        Ok(())
    }

    fn expiry_watch(expires_at: u64, stop: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || loop {
            if stop.load(Ordering::Acquire) {
                return;
            }
            let expired = now_ms().map(|now| now >= expires_at).unwrap_or(true);
            if expired {
                stop.store(true, Ordering::Release);
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        })
    }

    fn child(
        source: &BTreeMap<String, String>,
        device_id: &str,
        expires_at: &str,
    ) -> Result<(), ()> {
        // Direct child invocation cannot inherit the one-shot OIDC credentials.
        if source != &session_transport_environment(source) {
            return Err(());
        }
        let _ = record_candidate_stage(source, "entered", false);
        let expires_at = expires_at.parse::<u64>().map_err(|_| ())?;
        let grant = RegisteredSessionDevice {
            device_id: device_id.to_owned(),
            expires_at,
        };
        validate_transport_grant(&grant, now_ms()?).map_err(|_| ())?;
        let (identity_path, identity) =
            checked_transport_child_identity(source, &grant).map_err(|_| ())?;
        let _ = record_candidate_stage(source, "identity_ready", false);
        rca_native_agent::session_recovery::verify_registered_session_device(&identity, &grant)
            .map_err(|_| ())?;
        let _ = record_candidate_stage(source, "signed_recovered", false);
        let attempt = checked_runner_context(source).map_err(|_| ())?.0;
        if identity.attempt != attempt {
            return Err(());
        }
        let runner_temp = std::path::PathBuf::from(source.get("RUNNER_TEMP").ok_or(())?);
        let receipts = runner_temp.join("session-rca").join("receipts");
        std::fs::create_dir(&receipts).map_err(|_| ())?;
        rca_native_agent::validate_windows_private_path(&receipts, true).map_err(|_| ())?;
        let _ = record_candidate_stage(source, "receipts_ready", false);

        let managed =
            Arc::new(WindowsManagedSessions::new(Duration::from_secs(60 * 60)).map_err(|_| ())?);
        let stop = Arc::new(AtomicBool::new(false));
        let watch = expiry_watch(grant.expires_at, Arc::clone(&stop));
        let _ = record_candidate_stage(source, "wss_start", false);
        let result = run_native_managed_session(
            "https://rca.lirtual.dpdns.org/",
            &identity.private_key_pem,
            &grant.device_id,
            &receipts,
            Arc::clone(&managed),
            &stop,
            rca_native_agent::session::HeartbeatTiming::default(),
        );
        if result.is_err() {
            let _ = record_candidate_stage(source, "wss_error", false);
        }
        stop.store(true, Ordering::Release);
        if watch.join().is_err()
            || managed.stop_all(Duration::from_secs(8))
                != rca_native_agent::windows_job::JobCleanup::Confirmed
        {
            return Err(());
        }
        let cleanup = std::fs::remove_dir_all(identity_path.parent().ok_or(())?);
        if cleanup.is_err() {
            return Err(());
        }
        match result {
            Ok(())
            | Err(NativeFileError::Session(rca_native_agent::session::SessionError::Policy)) => {
                Ok(())
            }
            Err(_) => Err(()),
        }
    }

    pub fn run() -> Result<(), ()> {
        if !cfg!(target_arch = "x86_64") {
            return Err(());
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        let source = source()?;
        match args.as_slice() {
            [] => parent(&source),
            [mode, device_id, expires_at] if mode == "--session-transport" => {
                child(&source, device_id, expires_at)
            }
            _ => Err(()),
        }
    }
}

#[cfg(windows)]
fn main() {
    if windows::run().is_err() {
        eprintln!("Windows Session RCA Candidate unavailable or stopped.");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows Session RCA Candidate requires Windows x64.");
    std::process::exit(1);
}
