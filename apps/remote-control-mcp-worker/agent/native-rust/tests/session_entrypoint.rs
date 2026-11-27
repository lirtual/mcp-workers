//! Public process seam for the unshipped GitHub-hosted Linux Session entrypoint.
//! No production Worker/OIDC request, credential or installed Agent is used.
#[cfg(target_os = "linux")]
#[test]
fn unsupported_runner_cannot_create_an_attempt_or_start_a_session() {
    let root = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_rca-session-linux-candidate"))
        .env_clear()
        .env("RUNNER_TEMP", root.path())
        .env("GITHUB_ACTIONS", "false")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!root.path().join("session-rca").exists());
}

#[cfg(target_os = "linux")]
fn runner_command(root: &std::path::Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_rca-session-linux-candidate"));
    cmd.env_clear()
        .env("GITHUB_ACTIONS", "true")
        .env("RUNNER_ENVIRONMENT", "github-hosted")
        .env("GITHUB_WORKFLOW", "ubuntu")
        .env("GITHUB_RUN_ID", "12345")
        .env("GITHUB_RUN_ATTEMPT", "1")
        .env("ATTEMPT_ID", "123e4567-e89b-42d3-a456-426614174004")
        .env("RUNNER_TRACKING_ID", "synthetic-job-owner")
        .env("RUNNER_TEMP", root)
        .env("PATH", "/usr/bin:/bin");
    cmd
}

#[cfg(target_os = "linux")]
#[test]
fn one_shot_parent_without_oidc_cannot_create_an_identity() {
    let root = tempfile::tempdir().unwrap();
    let output = runner_command(root.path()).output().unwrap();
    assert!(!output.status.success());
    assert!(!root.path().join("session-rca").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn child_refuses_missing_parent_identity_without_creating_one() {
    let root = tempfile::tempdir().unwrap();
    let deadline = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000)
        .to_string();
    let output = runner_command(root.path())
        .args([
            "--session-transport",
            "123e4567-e89b-42d3-a456-426614174001",
            deadline.as_str(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!root.path().join("session-rca").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn credential_bearing_child_environment_is_denied_before_transport() {
    let root = tempfile::tempdir().unwrap();
    let deadline = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000)
        .to_string();
    let output = runner_command(root.path())
        .env("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "sensitive-oidc-bearer")
        .args([
            "--session-transport",
            "123e4567-e89b-42d3-a456-426614174001",
            deadline.as_str(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("credential-bearing"),
        "denial must distinguish forbidden inherited credentials from missing state"
    );
    assert!(!root.path().join("session-rca").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn malformed_inherited_environment_fails_without_panicking_or_logging_its_value() {
    use std::os::unix::ffi::OsStringExt;
    let root = tempfile::tempdir().unwrap();
    let output = runner_command(root.path())
        .env(
            "MALFORMED_SECRET",
            std::ffi::OsString::from_vec(vec![0xff, 0xfe]),
        )
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Session RCA unavailable"));
    assert!(!stderr.contains("panicked"));
    assert!(!root.path().join("session-rca").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn malformed_command_line_argument_fails_without_panicking() {
    use std::os::unix::ffi::OsStringExt;
    let root = tempfile::tempdir().unwrap();
    let output = runner_command(root.path())
        .arg(std::ffi::OsString::from_vec(vec![0xff, 0xfe]))
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Session RCA unavailable"));
    assert!(!stderr.contains("panicked"));
    assert!(!root.path().join("session-rca").exists());
}
