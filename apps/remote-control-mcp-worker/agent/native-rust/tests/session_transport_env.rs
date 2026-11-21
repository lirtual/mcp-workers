//! Keep GitHub one-time OIDC enrollment credentials out of the future
//! long-lived Rust Session transport process; compare the Node owner contract.
use rca_native_agent::session_transport_env::{
    apply_transport_environment, session_transport_environment,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

fn node_reference(source: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let agent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let script = r#"
        import {sessionTransportEnvironment} from './src/session-rca-client.ts';
        let input=''; for await (const chunk of process.stdin) input+=chunk;
        console.log(JSON.stringify(sessionTransportEnvironment(JSON.parse(input))));
    "#;
    let mut child = Command::new("node")
        .args([
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            script,
        ])
        .current_dir(agent)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Node 24 reference required in CI");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(source).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Node reference failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice::<Value>(&output.stdout)
        .unwrap()
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect()
}

fn synthetic_source() -> BTreeMap<String, String> {
    [
        ("PATH", "/bin:/usr/bin"),
        ("HOME", "/home/runner"),
        ("GITHUB_ACTIONS", "true"),
        ("RUNNER_ENVIRONMENT", "github-hosted"),
        ("GITHUB_WORKFLOW", "ubuntu"),
        ("GITHUB_REPOSITORY", "autoactions/github-actions"),
        ("GITHUB_RUN_ID", "1234"),
        ("GITHUB_RUN_ATTEMPT", "2"),
        ("ATTEMPT_ID", "123e4567-e89b-42d3-a456-426614174004"),
        ("RUNNER_TEMP", "/tmp/github"),
        ("RUNNER_TRACKING_ID", "job-cleanup-tracker"),
        ("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "OIDC_REQUEST_CREDENTIAL"),
        (
            "ACTIONS_ID_TOKEN_REQUEST_URL",
            "https://oidc.example/private",
        ),
        ("WORKFLOW_ACTION_OIDC_AUDIENCE", "OIDC_AUDIENCE"),
        ("GH_TOKEN", "SENSITIVE_GITHUB_TOKEN"),
        ("CLOUDFLARE_API_TOKEN", "SENSITIVE_CLOUDFLARE"),
        ("NODE_OPTIONS", "--require=unsafe"),
        ("LD_PRELOAD", "SENSITIVE_PRELOAD"),
        ("BASH_ENV", "/tmp/unreviewed.sh"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value.to_string()))
    .collect()
}

#[test]
fn rust_transport_environment_exactly_matches_node_allowlist_and_excludes_oidc() {
    let source = synthetic_source();
    let rust = session_transport_environment(&source);
    assert_eq!(rust, node_reference(&source));
    assert_eq!(
        rust.get("RUNNER_TRACKING_ID").unwrap(),
        "job-cleanup-tracker"
    );
    for secret in [
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        "ACTIONS_ID_TOKEN_REQUEST_URL",
        "WORKFLOW_ACTION_OIDC_AUDIENCE",
        "GH_TOKEN",
        "CLOUDFLARE_API_TOKEN",
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "BASH_ENV",
    ] {
        assert!(!rust.contains_key(secret), "leaked {secret}");
    }
}

#[test]
fn reviewed_ubuntu_shell_loader_is_only_preserved_under_exact_conditions() {
    let mut source = synthetic_source();
    source.insert("SESSION_ACTION_RCA".into(), "1".into());
    source.insert(
        "BASH_ENV".into(),
        "/home/runner/.config/session-actions/rca-env.bash".into(),
    );
    let approved = session_transport_environment(&source);
    assert_eq!(approved, node_reference(&source));
    assert_eq!(approved.get("SESSION_ACTION_RCA").unwrap(), "1");
    assert_eq!(
        approved.get("BASH_ENV").unwrap(),
        "/home/runner/.config/session-actions/rca-env.bash"
    );
    for (key, value) in [
        ("GITHUB_WORKFLOW", "windows"),
        ("GITHUB_REPOSITORY", "other/repo"),
        ("SESSION_ACTION_RCA", "0"),
        ("BASH_ENV", "/tmp/evil-env"),
        ("HOME", "relative"),
    ] {
        let mut denied = source.clone();
        denied.insert(key.into(), value.into());
        let actual = session_transport_environment(&denied);
        assert_eq!(actual, node_reference(&denied));
        assert!(!actual.contains_key("BASH_ENV"));
        assert!(!actual.contains_key("SESSION_ACTION_RCA"));
    }
}

#[test]
fn reviewed_windows_environment_key_aliases_match_node() {
    let mut source = synthetic_source();
    source.insert("SYSTEMROOT".into(), "C:\\Windows".into());
    source.insert("WINdir".into(), "C:\\Windows".into());
    source.insert("processor_architecture".into(), "AMD64".into());
    let actual = session_transport_environment(&source);
    assert_eq!(actual, node_reference(&source));
    assert_eq!(actual.get("SystemRoot").unwrap(), "C:\\Windows");
    assert_eq!(actual.get("WINDIR").unwrap(), "C:\\Windows");
    assert_eq!(actual.get("PROCESSOR_ARCHITECTURE").unwrap(), "AMD64");
}

#[cfg(target_os = "linux")]
#[test]
fn transport_subprocess_cannot_inherit_synthetic_registration_tokens() {
    let source = synthetic_source();
    let mut child = Command::new("/usr/bin/env");
    apply_transport_environment(&mut child, &source);
    let output = child.output().unwrap();
    assert!(output.status.success());
    let visible = String::from_utf8(output.stdout).unwrap();
    assert!(visible.contains("RUNNER_TRACKING_ID=job-cleanup-tracker"));
    assert!(visible.contains("GITHUB_RUN_ID=1234"));
    for secret in [
        "OIDC_REQUEST_CREDENTIAL",
        "OIDC_AUDIENCE",
        "SENSITIVE_GITHUB_TOKEN",
        "SENSITIVE_CLOUDFLARE",
        "SENSITIVE_PRELOAD",
        "NODE_OPTIONS",
        "BASH_ENV",
    ] {
        assert!(!visible.contains(secret), "child received {secret}");
    }
}
