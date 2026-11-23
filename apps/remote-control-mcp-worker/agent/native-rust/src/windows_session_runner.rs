//! Windows-only admission and process boundary for disposable GitHub Sessions.
//! Registration credentials remain in the short-lived parent; only a verified
//! device grant and the Runner-tracking environment reach the transport child.
use crate::session_enrollment::{
    load_existing_windows_session_identity, validate_session_identity, SessionDeviceIdentity,
    SessionPhysicalAttempt,
};
use crate::session_registration::{valid_session_transport_grant, RegisteredSessionDevice};
use crate::session_transport_env::session_transport_environment;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error)]
pub enum WindowsSessionRunnerError {
    #[error("unreviewed GitHub-hosted Windows Session Runner context")]
    InvalidRunner,
    #[error("invalid or expired Windows Session transport grant")]
    InvalidGrant,
    #[error("Windows Session child identity is not bound to this physical Attempt")]
    IdentityMismatch,
    #[error("missing or untrusted Windows Session identity state")]
    UntrustedIdentity,
    #[error("credential-free Windows Session transport could not start")]
    Spawn,
}

fn number(source: &BTreeMap<String, String>, key: &str) -> Option<u64> {
    let value = source.get(key)?.parse::<u64>().ok()?;
    (1..=MAX_SAFE_INTEGER).contains(&value).then_some(value)
}

/// Validate the actual hosted Windows workflow contract before OIDC access.
pub fn checked_runner_context(
    source: &BTreeMap<String, String>,
) -> Result<(SessionPhysicalAttempt, PathBuf), WindowsSessionRunnerError> {
    if source.get("GITHUB_ACTIONS").map(String::as_str) != Some("true")
        || source.get("RUNNER_ENVIRONMENT").map(String::as_str) != Some("github-hosted")
        || source.get("GITHUB_WORKFLOW").map(String::as_str) != Some("windows")
        || source.get("GITHUB_REPOSITORY").map(String::as_str) != Some("autoactions/github-actions")
        || source
            .get("RUNNER_TRACKING_ID")
            .is_none_or(String::is_empty)
    {
        return Err(WindowsSessionRunnerError::InvalidRunner);
    }
    let attempt_id = source
        .get("ATTEMPT_ID")
        .filter(|value| crate::identity::valid_device_id(value))
        .ok_or(WindowsSessionRunnerError::InvalidRunner)?;
    let runner_temp = PathBuf::from(
        source
            .get("RUNNER_TEMP")
            .ok_or(WindowsSessionRunnerError::InvalidRunner)?,
    );
    if !runner_temp.is_absolute() {
        return Err(WindowsSessionRunnerError::InvalidRunner);
    }
    Ok((
        SessionPhysicalAttempt {
            attempt_id: attempt_id.clone(),
            github_run_id: number(source, "GITHUB_RUN_ID")
                .ok_or(WindowsSessionRunnerError::InvalidRunner)?,
            github_run_attempt: number(source, "GITHUB_RUN_ATTEMPT")
                .ok_or(WindowsSessionRunnerError::InvalidRunner)?,
            workflow_name: "windows".into(),
        },
        runner_temp,
    ))
}

pub fn validate_transport_grant(
    grant: &RegisteredSessionDevice,
    now_ms: u64,
) -> Result<(), WindowsSessionRunnerError> {
    if !valid_session_transport_grant(grant, now_ms) {
        return Err(WindowsSessionRunnerError::InvalidGrant);
    }
    Ok(())
}

fn current_time_ms() -> Result<u64, WindowsSessionRunnerError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WindowsSessionRunnerError::InvalidGrant)?
        .as_millis()
        .try_into()
        .map_err(|_| WindowsSessionRunnerError::InvalidGrant)
}

/// Child mode cannot mint a replacement identity if parent state is missing.
pub fn checked_transport_child_identity(
    source: &BTreeMap<String, String>,
    grant: &RegisteredSessionDevice,
) -> Result<(PathBuf, SessionDeviceIdentity), WindowsSessionRunnerError> {
    let (attempt, runner_temp) = checked_runner_context(source)?;
    validate_transport_grant(grant, current_time_ms()?)?;
    let (path, identity) = load_existing_windows_session_identity(&runner_temp, &attempt)
        .map_err(|_| WindowsSessionRunnerError::UntrustedIdentity)?;
    validate_session_identity(&identity, &attempt)
        .map_err(|_| WindowsSessionRunnerError::IdentityMismatch)?;
    Ok((path, identity))
}

/// Spawn the transport with a strict environment allowlist and no OIDC/GH token.
pub fn spawn_credential_free_transport(
    executable: &std::path::Path,
    grant: &RegisteredSessionDevice,
    identity: &SessionDeviceIdentity,
    source: &BTreeMap<String, String>,
) -> Result<Child, WindowsSessionRunnerError> {
    let (attempt, _) = checked_runner_context(source)?;
    validate_session_identity(identity, &attempt)
        .map_err(|_| WindowsSessionRunnerError::IdentityMismatch)?;
    validate_transport_grant(grant, current_time_ms()?)?;
    let environment = session_transport_environment(source);
    if environment.get("ATTEMPT_ID") != Some(&attempt.attempt_id)
        || !environment.contains_key("RUNNER_TRACKING_ID")
    {
        return Err(WindowsSessionRunnerError::InvalidRunner);
    }
    use std::os::windows::process::CommandExt;
    Command::new(executable)
        .arg("--session-transport")
        .arg(&grant.device_id)
        .arg(grant.expires_at.to_string())
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP) // remains in Runner job.
        .spawn()
        .map_err(|_| WindowsSessionRunnerError::Spawn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_env() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("GITHUB_ACTIONS".into(), "true".into()),
            ("RUNNER_ENVIRONMENT".into(), "github-hosted".into()),
            ("GITHUB_WORKFLOW".into(), "windows".into()),
            (
                "GITHUB_REPOSITORY".into(),
                "autoactions/github-actions".into(),
            ),
            ("RUNNER_TRACKING_ID".into(), "job-1".into()),
            (
                "ATTEMPT_ID".into(),
                "123e4567-e89b-42d3-a456-426614174001".into(),
            ),
            ("GITHUB_RUN_ID".into(), "123".into()),
            ("GITHUB_RUN_ATTEMPT".into(), "1".into()),
            ("RUNNER_TEMP".into(), "C:\\runner\\temp".into()),
        ])
    }

    #[test]
    fn runner_admission_binds_windows_workflow_and_attempt() {
        let source = valid_env();
        let (attempt, path) = checked_runner_context(&source).unwrap();
        assert_eq!(attempt.workflow_name, "windows");
        assert_eq!(attempt.github_run_id, 123);
        assert_eq!(path, PathBuf::from("C:\\runner\\temp"));
    }

    #[test]
    fn runner_admission_rejects_unreviewed_workflow_and_repository() {
        for key in ["GITHUB_WORKFLOW", "GITHUB_REPOSITORY", "RUNNER_ENVIRONMENT"] {
            let mut source = valid_env();
            source.insert(key.into(), "unreviewed".into());
            assert!(matches!(
                checked_runner_context(&source),
                Err(WindowsSessionRunnerError::InvalidRunner)
            ));
        }
    }

    #[test]
    fn runner_admission_rejects_invalid_attempt_and_numeric_identity() {
        for (key, value) in [
            ("ATTEMPT_ID", "bad"),
            ("GITHUB_RUN_ID", "0"),
            ("GITHUB_RUN_ATTEMPT", "x"),
        ] {
            let mut source = valid_env();
            source.insert(key.into(), value.into());
            assert!(matches!(
                checked_runner_context(&source),
                Err(WindowsSessionRunnerError::InvalidRunner)
            ));
        }
    }
}
