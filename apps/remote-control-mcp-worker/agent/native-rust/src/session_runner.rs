//! Unshipped Linux GitHub Session one-shot registration -> child launch seam.
//! This does not request OIDC, contact production, or activate a Session Agent.
//! A future entrypoint must independently recover the signed device ID from
//! the Worker before calling this launcher and recheck expiry in the child.
use crate::identity::valid_device_id;
use crate::session_enrollment::{
    load_existing_linux_session_identity, validate_session_identity, SessionDeviceIdentity,
    SessionPhysicalAttempt,
};
use crate::session_registration::{valid_session_transport_grant, RegisteredSessionDevice};
use crate::session_transport_env::apply_transport_environment;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error)]
pub enum SessionRunnerError {
    #[error("unreviewed GitHub-hosted Session Runner context")]
    InvalidRunner,
    #[error("invalid or expired Session transport grant")]
    InvalidGrant,
    #[error("Session child identity is not bound to this physical Attempt")]
    IdentityMismatch,
    #[error("missing or untrusted Session transport identity state")]
    UntrustedIdentity,
    #[error("untrusted Session child executable")]
    UntrustedExecutable,
    #[error("credential-free Session transport could not start")]
    Spawn,
}

fn runner_number(source: &BTreeMap<String, String>, key: &str) -> Option<u64> {
    let value = source.get(key)?.parse::<u64>().ok()?;
    (1..=MAX_SAFE_INTEGER).contains(&value).then_some(value)
}

/// Matches Node's GitHub-hosted Ubuntu physical Attempt admission. Environment
/// variables alone are not an authorization proof: Worker validates actual
/// GitHub OIDC before issuing a device grant.
pub fn checked_runner_context(
    source: &BTreeMap<String, String>,
) -> Result<(SessionPhysicalAttempt, PathBuf), SessionRunnerError> {
    if source.get("GITHUB_ACTIONS").map(String::as_str) != Some("true")
        || source.get("RUNNER_ENVIRONMENT").map(String::as_str) != Some("github-hosted")
        || source.get("GITHUB_WORKFLOW").map(String::as_str) != Some("ubuntu")
        || source
            .get("RUNNER_TRACKING_ID")
            .is_none_or(String::is_empty)
    {
        return Err(SessionRunnerError::InvalidRunner);
    }
    let attempt_id = source
        .get("ATTEMPT_ID")
        .filter(|value| valid_device_id(value))
        .ok_or(SessionRunnerError::InvalidRunner)?;
    let github_run_id =
        runner_number(source, "GITHUB_RUN_ID").ok_or(SessionRunnerError::InvalidRunner)?;
    let github_run_attempt =
        runner_number(source, "GITHUB_RUN_ATTEMPT").ok_or(SessionRunnerError::InvalidRunner)?;
    let runner_temp = PathBuf::from(
        source
            .get("RUNNER_TEMP")
            .ok_or(SessionRunnerError::InvalidRunner)?,
    );
    if !runner_temp.is_absolute() {
        return Err(SessionRunnerError::InvalidRunner);
    }
    Ok((
        SessionPhysicalAttempt {
            attempt_id: attempt_id.clone(),
            github_run_id,
            github_run_attempt,
            workflow_name: "ubuntu".into(),
        },
        runner_temp,
    ))
}

pub fn validate_transport_grant(
    grant: &RegisteredSessionDevice,
    now_ms: u64,
) -> Result<(), SessionRunnerError> {
    if !valid_session_transport_grant(grant, now_ms) {
        return Err(SessionRunnerError::InvalidGrant);
    }
    Ok(())
}

fn current_time_ms() -> Result<u64, SessionRunnerError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SessionRunnerError::InvalidGrant)?
        .as_millis()
        .try_into()
        .map_err(|_| SessionRunnerError::InvalidGrant)
}

/// Child mode must recover the one-shot parent's exact Attempt-scoped key;
/// missing or unsafe identity state is never silently replaced by a new key.
/// This is local admission only: signed Worker recovery remains mandatory
/// before joining the authenticated transport.
pub fn checked_transport_child_identity(
    source: &BTreeMap<String, String>,
    grant: &RegisteredSessionDevice,
) -> Result<(PathBuf, SessionDeviceIdentity), SessionRunnerError> {
    let (attempt, runner_temp) = checked_runner_context(source)?;
    validate_transport_grant(grant, current_time_ms()?)?;
    load_existing_linux_session_identity(&runner_temp, &attempt)
        .map_err(|_| SessionRunnerError::UntrustedIdentity)
}

/// Stop the shared WSS/managed-session execution lease at the absolute Grant
/// deadline. The owning caller must still wait for native cleanup and preserve
/// Unknown if process termination cannot be confirmed. No new daemon is used.
pub fn start_session_expiry_watch(
    expires_at_ms: u64,
    stop: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<std::thread::JoinHandle<()>, SessionRunnerError> {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let now_ms = current_time_ms()?;
    if expires_at_ms <= now_ms || expires_at_ms > now_ms.saturating_add(300 * 60_000) {
        return Err(SessionRunnerError::InvalidGrant);
    }
    let remaining = Duration::from_millis(expires_at_ms - now_ms);
    let deadline = Instant::now() + remaining;
    let stop = std::sync::Arc::clone(stop);
    std::thread::Builder::new()
        .name("rca-session-expiry".into())
        .spawn(move || {
            while !stop.load(Ordering::Acquire) {
                match deadline.checked_duration_since(Instant::now()) {
                    Some(left) if !left.is_zero() => {
                        std::thread::park_timeout(left.min(Duration::from_millis(50)));
                    }
                    _ => {
                        stop.store(true, Ordering::Release);
                        break;
                    }
                }
            }
        })
        .map_err(|_| SessionRunnerError::Spawn)
}

/// Child-side Linux candidate: restore the already-enrolled identity, verify
/// it against the Worker, then join the existing signed WSS/SQLite/owned-process
/// executor. The caller supplies its SIGINT/SIGTERM Stop flag and the checked
/// bundled supervisor path. This is not yet a published executable entrypoint.
#[derive(Debug, Error)]
pub enum SessionChildError {
    #[error("Session child was stopped before transport admission")]
    Stopped,
    #[error(transparent)]
    Runner(#[from] SessionRunnerError),
    #[error("signed Session identity recovery failed")]
    Recovery,
    #[error("untrusted Session supervisor")]
    Supervisor,
    #[error("Session transport or physical cleanup failed")]
    Transport,
    #[error("Session expiry watcher failed")]
    Watch,
}

pub fn run_verified_linux_session_child(
    source: &BTreeMap<String, String>,
    grant: &RegisteredSessionDevice,
    supervisor: &Path,
    stop: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), SessionChildError> {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::Duration;
    if unsafe { libc::geteuid() } == 0 {
        return Err(SessionRunnerError::InvalidRunner.into());
    }
    if stop.load(Ordering::Acquire) {
        return Err(SessionChildError::Stopped);
    }
    let (file, identity) = checked_transport_child_identity(source, grant)?;
    checked_executable(supervisor)?;
    let managed = crate::linux_managed::LinuxManagedSessions::new(
        supervisor,
        Path::new("/bin/bash"),
        Duration::from_secs(60 * 60),
    )
    .map(Arc::new)
    .map_err(|_| SessionChildError::Supervisor)?;
    crate::session_recovery::verify_registered_session_device(&identity, grant)
        .map_err(|_| SessionChildError::Recovery)?;
    // A job cancellation arriving during HTTPS recovery must not admit WSS.
    if stop.load(Ordering::Acquire) {
        return Err(SessionChildError::Stopped);
    }
    let watch = start_session_expiry_watch(grant.expires_at, stop)?;
    let receipts = file
        .parent()
        .ok_or(SessionRunnerError::UntrustedIdentity)?
        .join("receipts");
    let result = crate::native_file::run_native_managed_session(
        crate::session_recovery::ORIGIN,
        &identity.private_key_pem,
        &grant.device_id,
        &receipts,
        managed,
        stop,
        crate::session::HeartbeatTiming::default(),
    );
    stop.store(true, Ordering::Release);
    watch.join().map_err(|_| SessionChildError::Watch)?;
    match result {
        Ok(())
        | Err(crate::native_file::NativeFileError::Session(crate::session::SessionError::Policy)) => {
            Ok(())
        }
        Err(_) => Err(SessionChildError::Transport),
    }
}

fn checked_executable(program: &Path) -> Result<(), SessionRunnerError> {
    let meta =
        fs::symlink_metadata(program).map_err(|_| SessionRunnerError::UntrustedExecutable)?;
    if !program.is_absolute()
        || !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.nlink() != 1
        || meta.permissions().mode() & 0o022 != 0
        || meta.permissions().mode() & 0o6000 != 0
        || meta.permissions().mode() & 0o111 == 0
        || fs::canonicalize(program).ok().as_deref() != Some(program)
    {
        return Err(SessionRunnerError::UntrustedExecutable);
    }
    Ok(())
}

/// Start the already-reviewed executable as a new Unix session, not via shell.
/// The long-lived process receives only identity ID + expiry arguments; never
/// the GitHub OIDC URL, request bearer, JWT or arbitrary inherited credentials.
/// RUNNER_TRACKING_ID remains available for GitHub job termination ownership.
/// The returned Child can be waited by tests; dropping it is intentionally
/// nonblocking, matching Node's detached/unref registration parent.
pub fn spawn_credential_free_transport(
    program: &Path,
    grant: &RegisteredSessionDevice,
    identity: &SessionDeviceIdentity,
    source: &BTreeMap<String, String>,
) -> Result<Child, SessionRunnerError> {
    let (attempt, _) = checked_runner_context(source)?;
    validate_session_identity(identity, &attempt)
        .map_err(|_| SessionRunnerError::IdentityMismatch)?;
    validate_transport_grant(grant, current_time_ms()?)?;
    checked_executable(program)?;
    let mut child = Command::new(program);
    child
        .arg("--session-transport")
        .arg(&grant.device_id)
        .arg(grant.expires_at.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    apply_transport_environment(&mut child, source);
    // setsid is async-signal-safe, and the closure does no heap allocation
    // between fork and exec. GitHub still owns the child via RUNNER_TRACKING_ID.
    unsafe {
        child.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    child.spawn().map_err(|_| SessionRunnerError::Spawn)
}
