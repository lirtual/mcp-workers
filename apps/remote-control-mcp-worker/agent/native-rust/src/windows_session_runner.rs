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
use std::fs::OpenOptions;
use std::io::Write;
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

/// Candidate-only, private, bounded phase evidence. It is never an authority
/// for WSS/Grant readiness and contains no token, path, or exception details.
pub fn record_candidate_stage(
    source: &BTreeMap<String, String>,
    stage: &str,
    create: bool,
) -> Result<(), WindowsSessionRunnerError> {
    if !matches!(
        stage,
        "pending"
            | "entered"
            | "identity_ready"
            | "signed_recovered"
            | "receipts_ready"
            | "wss_start"
            | "wss_error"
    ) {
        return Err(WindowsSessionRunnerError::InvalidRunner);
    }
    let (_, runner_temp) = checked_runner_context(source)?;
    let directory = runner_temp.join("session-rca");
    crate::validate_windows_private_path(&directory, true)
        .map_err(|_| WindowsSessionRunnerError::UntrustedIdentity)?;
    let stage_path = directory.join("transport-stage");
    let mut file = if create {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage_path)
            .map_err(|_| WindowsSessionRunnerError::UntrustedIdentity)?;
        crate::seal_new_windows_private_file(&stage_path)
            .map_err(|_| WindowsSessionRunnerError::UntrustedIdentity)?;
        file
    } else {
        crate::validate_windows_private_path(&stage_path, false)
            .map_err(|_| WindowsSessionRunnerError::UntrustedIdentity)?;
        OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&stage_path)
            .map_err(|_| WindowsSessionRunnerError::UntrustedIdentity)?
    };
    file.write_all(stage.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|_| WindowsSessionRunnerError::UntrustedIdentity)
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
    fn private_candidate_stage_is_bounded_and_attempt_scoped() {
        // Exercise the real hosted Runner's temporary-drive ACL when available.
        let runner_root = std::env::var_os("RUNNER_TEMP");
        let temp = match runner_root {
            Some(path) => tempfile::tempdir_in(std::path::PathBuf::from(path)).unwrap(),
            None => tempfile::tempdir().unwrap(),
        };
        let mut env = valid_env();
        env.insert("RUNNER_TEMP".into(), temp.path().display().to_string());
        let (attempt, _) = checked_runner_context(&env).unwrap();
        crate::session_enrollment::load_or_create_windows_session_identity(temp.path(), &attempt)
            .unwrap();
        record_candidate_stage(&env, "pending", true).unwrap();
        record_candidate_stage(&env, "identity_ready", false).unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.path().join("session-rca/transport-stage")).unwrap(),
            "identity_ready\n"
        );

        // Physical Candidate #45132982658 stopped at signed_recovered. Check
        // the exact next OS-level create + inherited-ACL path on Windows CI.
        let receipts = temp.path().join("session-rca/receipts");
        std::fs::create_dir(&receipts).unwrap();
        crate::seal_new_windows_private_directory(&receipts).unwrap();
        crate::validate_windows_private_path(&receipts, true).unwrap();
        record_candidate_stage(&env, "receipts_ready", false).unwrap();
        assert_eq!(
            std::fs::read_to_string(temp.path().join("session-rca/transport-stage")).unwrap(),
            "receipts_ready\n"
        );
        assert!(record_candidate_stage(&env, "untrusted", false).is_err());
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
    #[test]
    fn credential_free_process_environment_survives_windows_spawn() {
        const MARKER: &str = "RCA_WINDOWS_CHILD_ENV_TEST";
        if std::env::var(MARKER).as_deref() == Ok("1") {
            let mut actual: BTreeMap<String, String> = std::env::vars_os()
                .map(|(key, value)| {
                    Ok((
                        key.into_string().map_err(|_| ())?,
                        value.into_string().map_err(|_| ())?,
                    ))
                })
                .collect::<Result<_, ()>>()
                .expect("child environment contains only UTF-8 keys and values");
            actual.remove(MARKER);
            assert!(
                actual == session_transport_environment(&actual),
                "Windows CreateProcess changed the strict transport allowlist"
            );
            return;
        }

        let mut source = valid_env();
        for key in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "COMSPEC",
        ] {
            if let Ok(value) = std::env::var(key) {
                source.insert(key.to_owned(), value);
            }
        }
        let child_env = session_transport_environment(&source);
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "windows_session_runner::tests::credential_free_process_environment_survives_windows_spawn",
                "--nocapture",
            ])
            .env_clear()
            .envs(child_env)
            .env(MARKER, "1")
            .output()
            .expect("launch credential-free synthetic child");
        assert!(
            output.status.success(),
            "Windows transport environment did not survive process launch"
        );
    }
}
