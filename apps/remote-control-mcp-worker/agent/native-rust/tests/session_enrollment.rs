//! Independent Node 24 contract for GitHub-hosted Session enrollment proof.
//! No Runner OIDC token, persistent Agent identity or real Worker is involved.
use rca_native_agent::session_enrollment::{
    new_session_identity, sign_session_enrollment_nonce, validate_session_identity,
    SessionDeviceIdentity, SessionPhysicalAttempt,
};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

const NONCE: &str = "dummy_nonce_AAAAAAAAAAAAAAAAAA";

fn attempt() -> SessionPhysicalAttempt {
    SessionPhysicalAttempt {
        attempt_id: "123e4567-e89b-42d3-a456-426614174004".into(),
        github_run_id: 1234,
        github_run_attempt: 2,
        workflow_name: "ubuntu".into(),
    }
}

fn node(script: &str, input: &Value) -> Value {
    let agent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
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
        .expect("Node 24 reference must be available in CI");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Node reference failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn node_generated_attempt_identity_and_enrollment_proof_match_rust() {
    let reference = node(
        r#"
        import {newSessionDeviceIdentity,signSessionEnrollmentNonce} from './src/session-device-identity.ts';
        let data=''; for await (const chunk of process.stdin) data+=chunk;
        const {attempt,nonce}=JSON.parse(data);
        const identity=newSessionDeviceIdentity(attempt);
        console.log(JSON.stringify({identity,proof:signSessionEnrollmentNonce(identity,nonce)}));
        "#,
        &json!({"attempt":attempt(),"nonce":NONCE}),
    );
    let identity: SessionDeviceIdentity =
        serde_json::from_value(reference["identity"].clone()).unwrap();
    validate_session_identity(&identity, &attempt()).unwrap();
    assert_eq!(
        sign_session_enrollment_nonce(&identity, NONCE).unwrap(),
        reference["proof"].as_str().unwrap()
    );
}

#[test]
fn rust_generated_identity_and_proof_match_node_and_are_attempt_scoped() {
    let identity = new_session_identity(&attempt()).unwrap();
    validate_session_identity(&identity, &attempt()).unwrap();
    let proof = sign_session_enrollment_nonce(&identity, NONCE).unwrap();
    let result = node(
        r#"
        import {validateSessionDeviceIdentity,signSessionEnrollmentNonce} from './src/session-device-identity.ts';
        let data=''; for await (const chunk of process.stdin) data+=chunk;
        const {identity,nonce}=JSON.parse(data);
        validateSessionDeviceIdentity(identity,identity.attempt);
        console.log(JSON.stringify({proof:signSessionEnrollmentNonce(identity,nonce)}));
        "#,
        &json!({"identity":identity,"nonce":NONCE}),
    );
    assert_eq!(result["proof"], proof);

    let another = new_session_identity(&attempt()).unwrap();
    assert_ne!(identity.public_key, another.public_key);
}

#[test]
fn malformed_attempt_cross_attempt_or_mismatched_identity_fail_closed() {
    let valid = attempt();
    let mut bad = valid.clone();
    bad.github_run_id = 0;
    assert!(new_session_identity(&bad).is_err());
    bad = valid.clone();
    bad.github_run_attempt = 9_007_199_254_740_992;
    assert!(new_session_identity(&bad).is_err());
    bad = valid.clone();
    bad.attempt_id = "123e4567-e89b-42d3-a456-42661417400X".into();
    assert!(new_session_identity(&bad).is_err());
    bad = valid.clone();
    bad.workflow_name = "release".into();
    assert!(new_session_identity(&bad).is_err());

    let identity = new_session_identity(&valid).unwrap();
    bad = valid.clone();
    bad.github_run_attempt += 1;
    assert!(validate_session_identity(&identity, &bad).is_err());
    let mut tampered = identity.clone();
    tampered.public_key = new_session_identity(&valid).unwrap().public_key;
    assert!(sign_session_enrollment_nonce(&tampered, NONCE).is_err());
    tampered = identity.clone();
    tampered.private_key_pem = new_session_identity(&valid).unwrap().private_key_pem;
    assert!(validate_session_identity(&tampered, &valid).is_err());
    for nonce in [
        "short",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "x:",
    ] {
        assert!(sign_session_enrollment_nonce(&identity, nonce).is_err());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn linux_runner_store_recovers_node_identity_and_node_recovers_rust_identity() {
    use rca_native_agent::session_enrollment::load_or_create_linux_session_identity;
    let node_root = tempfile::tempdir().unwrap();
    let reference = node(
        r#"
        import {loadOrCreateLinuxSessionIdentity} from './src/session-identity-store.ts';
        let data=''; for await (const chunk of process.stdin) data+=chunk;
        const {root,attempt}=JSON.parse(data);
        const result=await loadOrCreateLinuxSessionIdentity(root,attempt);
        console.log(JSON.stringify(result.identity));
        "#,
        &json!({"root":node_root.path(),"attempt":attempt()}),
    );
    let (_, rust_read) =
        load_or_create_linux_session_identity(node_root.path(), &attempt()).unwrap();
    assert_eq!(
        rust_read.public_key,
        reference["public_key"].as_str().unwrap()
    );

    let rust_root = tempfile::tempdir().unwrap();
    let (_, rust_created) =
        load_or_create_linux_session_identity(rust_root.path(), &attempt()).unwrap();
    let read_by_node = node(
        r#"
        import {loadOrCreateLinuxSessionIdentity} from './src/session-identity-store.ts';
        let data=''; for await (const chunk of process.stdin) data+=chunk;
        const {root,attempt}=JSON.parse(data);
        const result=await loadOrCreateLinuxSessionIdentity(root,attempt);
        console.log(JSON.stringify({public_key:result.identity.public_key}));
        "#,
        &json!({"root":rust_root.path(),"attempt":attempt()}),
    );
    assert_eq!(read_by_node["public_key"], rust_created.public_key);
}

#[cfg(target_os = "linux")]
#[test]
fn linux_runner_store_is_attempt_scoped_and_rejects_unsafe_links_and_modes() {
    use rca_native_agent::session_enrollment::load_or_create_linux_session_identity;
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let (_, first) = load_or_create_linux_session_identity(root.path(), &attempt()).unwrap();
    let (_, second) = load_or_create_linux_session_identity(root.path(), &attempt()).unwrap();
    assert_eq!(first.public_key, second.public_key);

    let mut other_attempt = attempt();
    other_attempt.github_run_attempt += 1;
    assert!(load_or_create_linux_session_identity(root.path(), &other_attempt).is_err());
    let file = root.path().join("session-rca/identity.json");
    let alias = root.path().join("session-rca/identity-alias");
    std::fs::hard_link(&file, &alias).unwrap();
    assert!(load_or_create_linux_session_identity(root.path(), &attempt()).is_err());
    std::fs::remove_file(&alias).unwrap();

    let symlink_root = root.path().with_extension("alias");
    symlink(root.path(), &symlink_root).unwrap();
    assert!(load_or_create_linux_session_identity(&symlink_root, &attempt()).is_err());
    std::fs::remove_file(&symlink_root).unwrap();

    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(load_or_create_linux_session_identity(root.path(), &attempt()).is_err());
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(load_or_create_linux_session_identity(root.path(), &attempt()).is_ok());

    let poisoned = tempfile::tempdir().unwrap();
    let directory = poisoned.path().join("session-rca");
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let existing = directory.join("identity.json");
    std::fs::write(&existing, b"{invalid-json").unwrap();
    std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(load_or_create_linux_session_identity(poisoned.path(), &attempt()).is_err());
    assert_eq!(std::fs::read(&existing).unwrap(), b"{invalid-json");
}

#[cfg(target_os = "linux")]
#[test]
fn concurrent_runner_identity_creation_publishes_exactly_one_key() {
    use rca_native_agent::session_enrollment::load_or_create_linux_session_identity;
    let root = tempfile::tempdir().unwrap();
    let keys = std::thread::scope(|scope| {
        let tasks: Vec<_> = (0..12)
            .map(|_| {
                scope.spawn(|| {
                    load_or_create_linux_session_identity(root.path(), &attempt())
                        .unwrap()
                        .1
                        .public_key
                })
            })
            .collect();
        tasks
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(keys.iter().all(|key| key == &keys[0]));
}
