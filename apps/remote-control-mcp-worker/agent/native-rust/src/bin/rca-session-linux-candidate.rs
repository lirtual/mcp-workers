//! Unshipped GitHub-hosted Ubuntu Session entrypoint for #914.
//! Never package or invoke on a real Runner without the remaining Gate 1 gates.
#[cfg(target_os = "linux")]
mod ubuntu {
    use rca_native_agent::session_enrollment::load_or_create_linux_session_identity;
    use rca_native_agent::session_recovery::verify_and_spawn_session_transport;
    use rca_native_agent::session_registration::{
        register_session_device, runner_oidc_token, RegisteredSessionDevice,
    };
    use rca_native_agent::session_runner::{
        checked_runner_context, run_verified_linux_session_child, validate_transport_grant,
    };
    use rca_native_agent::session_transport_env::session_transport_environment;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    static SIGNAL_STOP: AtomicBool = AtomicBool::new(false);

    extern "C" fn request_stop(_: libc::c_int) {
        SIGNAL_STOP.store(true, Ordering::Release);
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

    fn parent(source: &BTreeMap<String, String>) -> Result<(), ()> {
        let (attempt, runner_temp) = checked_runner_context(source).map_err(|_| ())?;
        let audience = source.get("WORKFLOW_ACTION_OIDC_AUDIENCE").ok_or(())?;
        let request_url = source.get("ACTIONS_ID_TOKEN_REQUEST_URL").ok_or(())?;
        let request_token = source.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN").ok_or(())?;
        let executable = std::env::current_exe().map_err(|_| ())?;

        let (_, identity) =
            load_or_create_linux_session_identity(&runner_temp, &attempt).map_err(|_| ())?;
        let jwt = runner_oidc_token(request_url, request_token, audience).map_err(|_| ())?;
        let grant = register_session_device(&identity, &jwt).map_err(|_| ())?;
        // A successful signed Worker recovery is mandatory before this detached
        // process is launched. OIDC material is stripped by env_clear().
        let _child = verify_and_spawn_session_transport(&identity, &grant, &executable, source)
            .map_err(|_| ())?;
        Ok(())
    }

    fn child(source: &BTreeMap<String, String>, device_id: &str, expiry: &str) -> Result<(), ()> {
        // A directly invoked child cannot smuggle OIDC or arbitrary process
        // injection through its inherited environment.
        if source != &session_transport_environment(source) {
            eprintln!("Session RCA refused credential-bearing child environment.");
            return Err(());
        }
        let grant = RegisteredSessionDevice {
            device_id: device_id.to_owned(),
            expires_at: expiry.parse::<u64>().map_err(|_| ())?,
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ())?
            .as_millis() as u64;
        validate_transport_grant(&grant, now).map_err(|_| ())?;
        checked_runner_context(source).map_err(|_| ())?;

        // The versioned candidate binary and existing C supervisor must be
        // bundled as siblings. No arbitrary environment path crosses child mode.
        let executable = std::env::current_exe().map_err(|_| ())?;
        let supervisor = executable.with_file_name("session-supervisor");
        install_stop_signals()?;
        let stop = Arc::new(AtomicBool::new(false));
        let signal_stop = Arc::clone(&stop);
        let monitor = std::thread::spawn(move || {
            while !signal_stop.load(Ordering::Acquire) {
                if SIGNAL_STOP.load(Ordering::Acquire) {
                    signal_stop.store(true, Ordering::Release);
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let result = run_verified_linux_session_child(source, &grant, &supervisor, &stop);
        stop.store(true, Ordering::Release);
        monitor.join().map_err(|_| ())?;
        result.map_err(|_| ())
    }

    pub fn run() -> Result<(), ()> {
        if unsafe { libc::geteuid() } == 0 {
            return Err(());
        }
        let args: Vec<String> = std::env::args_os()
            .skip(1)
            .map(|value| value.into_string().map_err(|_| ()))
            .collect::<Result<_, _>>()?;
        let source = source()?;
        match args.as_slice() {
            [] => parent(&source),
            [mode, device_id, expiry] if mode == "--session-transport" => {
                child(&source, device_id, expiry)
            }
            _ => Err(()),
        }
    }
}

#[cfg(target_os = "linux")]
fn main() {
    if ubuntu::run().is_err() {
        eprintln!("Session RCA candidate unavailable; existing Agent is unchanged.");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("Session RCA candidate is Linux-only and unshipped.");
    std::process::exit(1);
}
