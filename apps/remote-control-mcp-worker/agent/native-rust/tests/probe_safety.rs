//! Gate 0's file effect is safe only inside a disposable private test root.
use rca_native_agent::gate0_probe::{Gate0Probe, ProbeError};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;

fn private_probe_root() -> tempfile::TempDir {
    let tmp = tempfile::Builder::new()
        .prefix("rca-rust-probe-")
        .tempdir()
        .unwrap();
    std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    tmp
}

#[test]
fn unsafe_root_names_permissions_and_symlinks_fail_closed() {
    let public = tempfile::Builder::new()
        .prefix("rca-rust-probe-")
        .tempdir()
        .unwrap();
    std::fs::set_permissions(public.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        Gate0Probe::new(public.path()),
        Err(ProbeError::UnsafeRoot)
    ));

    let unrelated = tempfile::Builder::new()
        .prefix("not-rca-probe-")
        .tempdir()
        .unwrap();
    std::fs::set_permissions(unrelated.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(
        Gate0Probe::new(unrelated.path()),
        Err(ProbeError::UnsafeRoot)
    ));

    let root = private_probe_root();
    let link_home = tempfile::tempdir().unwrap();
    let link = link_home.path().join("rca-rust-probe-link");
    std::os::unix::fs::symlink(root.path(), &link).unwrap();
    assert!(matches!(
        Gate0Probe::new(&link),
        Err(ProbeError::UnsafeRoot)
    ));
}

#[test]
fn out_of_scope_and_malformed_frames_cannot_admit_an_effect() {
    let root = private_probe_root();
    let canonical_root = std::fs::canonicalize(root.path()).unwrap();
    let mut probe = Gate0Probe::new(&canonical_root).unwrap();
    let outside = canonical_root.join("outside.txt");
    let write = json!({
        "kind":"operation", "tool":"write_file",
        "request_id":"11111111-1111-1111-1111-111111111111",
        "operation_id":"out-of-scope",
        "arguments":{"path":outside,"content":"no","mode":"rewrite"},
    })
    .to_string();
    assert!(matches!(
        probe.handle(&write),
        Err(ProbeError::InvalidFrame)
    ));
    assert!(!outside.exists());

    // The real Worker sends mode; append cannot admit a receipt or effect.
    let append = json!({
        "kind":"operation", "tool":"write_file",
        "request_id":"99999999-9999-9999-9999-999999999999",
        "operation_id":"append-rejected",
        "arguments":{"path":canonical_root.join("probe.txt"),"content":"unsafe","mode":"append"},
    })
    .to_string();
    assert!(matches!(
        probe.handle(&append),
        Err(ProbeError::InvalidFrame)
    ));
    assert!(!canonical_root.join("probe.txt").exists());

    let status: Value = serde_json::from_str(
        &probe
            .handle(
                &json!({
                    "kind":"operation", "tool":"get_operation_status",
                    "request_id":"22222222-2222-2222-2222-222222222222",
                    "operation_id":"out-of-scope",
                    "arguments":{"operation_id":"out-of-scope"},
                })
                .to_string(),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status["result"]["status"], "not_found");

    // Even the fixed read target must not follow a pre-existing symlink.
    let secret = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(secret.path(), "outside-secret").unwrap();
    let target = canonical_root.join("probe.txt");
    std::os::unix::fs::symlink(secret.path(), &target).unwrap();
    let read = json!({
        "kind":"read", "tool":"read_file",
        "request_id":"33333333-3333-3333-3333-333333333333",
        "arguments":{"path":target},
    })
    .to_string();
    let response: Value = serde_json::from_str(&probe.handle(&read).unwrap()).unwrap();
    assert_eq!(response["status"], "failed");
    assert!(response.get("text").is_none());
    assert!(matches!(
        probe.handle("rc-v2:ping"),
        Err(ProbeError::InvalidFrame)
    ));
    assert!(matches!(
        probe.handle(&"x".repeat(65_537)),
        Err(ProbeError::InvalidFrame)
    ));
}
