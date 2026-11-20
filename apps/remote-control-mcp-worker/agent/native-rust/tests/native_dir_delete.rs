//! Node-compatible, receipt-guarded local directory create and regular-file delete.
use rca_native_agent::native_write::{NativeWriteError, NativeWriteExecutor};
use serde_json::json;
use std::fs;

#[test]
fn create_directory_is_single_level_idempotent_conflict_safe_and_restart_safe() {
    let root = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    let target = root.path().join("created");
    let first = json!({"path":target});
    let other = root.path().join("must-not-create");

    let mut agent = NativeWriteExecutor::open(&receipts).unwrap();
    let result = agent
        .create_directory_with_lease("mkdir-001", &first, || true)
        .unwrap();
    assert_eq!(result.state, "completed");
    assert!(target.is_dir());
    assert_eq!(
        agent
            .create_directory_with_lease("mkdir-001", &first, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(
        agent
            .create_directory_with_lease("mkdir-001", &json!({"path":other}), || true)
            .unwrap()
            .state,
        "conflict"
    );
    assert!(!other.exists());
    drop(agent);
    let mut restarted = NativeWriteExecutor::open(&receipts).unwrap();
    assert_eq!(
        restarted
            .create_directory_with_lease("mkdir-001", &first, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(
        restarted.get_receipt("mkdir-001").unwrap().unwrap().state,
        "completed"
    );
    assert_eq!(
        restarted
            .delete_file_with_lease("mkdir-001", &first, || true)
            .unwrap()
            .state,
        "conflict",
        "the same ID cannot be reused for a different tool"
    );
}

#[test]
fn delete_only_regular_file_and_never_replay_or_delete_symlinks() {
    let root = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    let target = root.path().join("target.txt");
    fs::write(&target, "must be removed once").unwrap();
    let arguments = json!({"path":target});
    let mut agent = NativeWriteExecutor::open(&receipts).unwrap();
    assert_eq!(
        agent
            .delete_file_with_lease("unlink-001", &arguments, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert!(!target.exists());
    fs::write(&target, "new file at same path").unwrap();
    assert_eq!(
        agent
            .delete_file_with_lease("unlink-001", &arguments, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "new file at same path"
    );
    assert_eq!(
        agent
            .delete_file_with_lease(
                "unlink-001",
                &json!({"path":root.path().join("other")}),
                || true
            )
            .unwrap()
            .state,
        "conflict"
    );

    assert_eq!(
        agent
            .delete_file_with_lease("unlink-002", &json!({"path":root.path()}), || true)
            .unwrap()
            .state,
        "failed"
    );
    assert!(root.path().is_dir());

    #[cfg(unix)]
    {
        let link = root.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(
            agent
                .delete_file_with_lease("unlink-003", &json!({"path":link}), || true)
                .unwrap()
                .state,
            "failed"
        );
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "new file at same path"
        );
    }

    drop(agent);
    let mut restarted = NativeWriteExecutor::open(&receipts).unwrap();
    assert_eq!(
        restarted
            .delete_file_with_lease("unlink-001", &arguments, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "new file at same path"
    );
}

#[test]
fn invalid_arguments_and_revoked_leases_never_apply_or_misclassify_effects() {
    let root = tempfile::tempdir().unwrap();
    let mut agent = NativeWriteExecutor::open(&root.path().join("receipts")).unwrap();
    for bad in [
        json!({"path":"file:///tmp/not-a-path"}),
        json!({"path":""}),
        json!({"path":"/tmp/ok", "recursive":true}),
        json!({"path":true}),
    ] {
        assert!(matches!(
            agent.create_directory_with_lease("bad-dir", &bad, || true),
            Err(NativeWriteError::InvalidInput)
        ));
        assert!(matches!(
            agent.delete_file_with_lease("bad-del", &bad, || true),
            Err(NativeWriteError::InvalidInput)
        ));
    }
    assert!(agent.get_receipt("bad-dir").unwrap().is_none());

    let path = root.path().join("revoked");
    let operation = json!({"path":path});
    assert!(matches!(
        agent.create_directory_with_lease("revoked-before", &operation, || false),
        Err(NativeWriteError::LeaseRevoked)
    ));
    assert!(!path.exists());
    assert!(agent.get_receipt("revoked-before").unwrap().is_none());
    let mut checks = 0;
    let outcome = agent
        .create_directory_with_lease("revoked-after", &operation, || {
            checks += 1;
            checks == 1
        })
        .unwrap();
    assert_eq!(outcome.state, "failed");
    assert_eq!(
        outcome.receipt.unwrap().safe_result_summary.as_deref(),
        Some("Lease revoked before any effect.")
    );
    assert!(!path.exists());

    let missing_parent = root.path().join("missing").join("child");
    assert_eq!(
        agent
            .create_directory_with_lease("missing-parent", &json!({"path":missing_parent}), || true)
            .unwrap()
            .state,
        "failed"
    );
    assert!(!missing_parent.exists());
}
