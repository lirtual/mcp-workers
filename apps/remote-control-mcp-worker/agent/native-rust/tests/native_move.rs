//! Node link+unlink move: only an existing ordinary file, no overwrite,
//! SQLite receipt admission before effects, and no replay after interruption.
use rca_native_agent::native_write::{NativeWriteError, NativeWriteExecutor};
use serde_json::json;
use std::fs;

#[test]
fn move_file_preserves_inode_and_same_id_never_reexecutes_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    let source = root.path().join("source.txt");
    let target = root.path().join("target.txt");
    fs::write(&source, "original").unwrap();
    #[cfg(unix)]
    let original_inode = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(&source).unwrap().ino()
    };
    let arguments = json!({"source":source,"destination":target});
    let mut agent = NativeWriteExecutor::open(&receipts).unwrap();
    assert_eq!(
        agent
            .move_file_with_lease("move-001", &arguments, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert!(!source.exists());
    assert_eq!(fs::read_to_string(&target).unwrap(), "original");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(fs::metadata(&target).unwrap().ino(), original_inode);
    }
    fs::write(&source, "new source content").unwrap();
    assert_eq!(
        agent
            .move_file_with_lease("move-001", &arguments, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "new source content");
    assert_eq!(fs::read_to_string(&target).unwrap(), "original");
    assert_eq!(
        agent
            .move_file_with_lease(
                "move-001",
                &json!({"source":source,
            "destination":root.path().join("other")}),
                || true
            )
            .unwrap()
            .state,
        "conflict"
    );
    drop(agent);
    let mut restarted = NativeWriteExecutor::open(&receipts).unwrap();
    assert_eq!(
        restarted
            .move_file_with_lease("move-001", &arguments, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "new source content");
}

#[test]
fn invalid_source_existing_destination_and_same_resolved_path_never_move() {
    let root = tempfile::tempdir().unwrap();
    let mut agent = NativeWriteExecutor::open(&root.path().join("receipts")).unwrap();
    let source = root.path().join("source.txt");
    let destination = root.path().join("already-here.txt");
    fs::write(&source, "source").unwrap();
    fs::write(&destination, "existing destination").unwrap();
    assert_eq!(
        agent
            .move_file_with_lease(
                "existing-dest",
                &json!({"source":source,"destination":destination}),
                || true
            )
            .unwrap()
            .state,
        "failed"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "source");
    assert_eq!(
        fs::read_to_string(&destination).unwrap(),
        "existing destination"
    );

    let same_resolved = json!({"source":source,
        "destination":root.path().join("child").join("..").join("source.txt")});
    assert_eq!(
        agent
            .move_file_with_lease("same-resolved", &same_resolved, || true)
            .unwrap()
            .state,
        "failed"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "source");

    assert_eq!(
        agent
            .move_file_with_lease(
                "directory-src",
                &json!({"source":root.path(),
            "destination":root.path().join("directory-should-not-move")}),
                || true
            )
            .unwrap()
            .state,
        "failed"
    );

    #[cfg(unix)]
    {
        let link = root.path().join("source-symlink");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert_eq!(
            agent
                .move_file_with_lease(
                    "symlink-src",
                    &json!({"source":link,"destination":root.path().join("link-target")}),
                    || true
                )
                .unwrap()
                .state,
            "failed"
        );
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
    }
    for invalid in [
        json!({"source":"file:///tmp/a","destination":"/tmp/b"}),
        json!({"source":"/tmp/a","destination":"/tmp/a"}),
        json!({"source":"/tmp/a","destination":"/tmp/b","overwrite":true}),
        json!({"source":"/tmp/a"}),
    ] {
        assert!(matches!(
            agent.move_file_with_lease("bad-paths", &invalid, || true),
            Err(NativeWriteError::InvalidInput)
        ));
    }
    assert!(agent.get_receipt("bad-paths").unwrap().is_none());
}

#[test]
fn move_revoked_lease_and_source_unlink_failure_do_not_leave_destination() {
    let root = tempfile::tempdir().unwrap();
    let mut agent = NativeWriteExecutor::open(&root.path().join("receipts")).unwrap();
    let source = root.path().join("source.txt");
    let dest = root.path().join("target.txt");
    fs::write(&source, "original").unwrap();
    let args = json!({"source":source,"destination":dest});
    assert!(matches!(
        agent.move_file_with_lease("revoked-before", &args, || false),
        Err(NativeWriteError::LeaseRevoked)
    ));
    assert!(agent.get_receipt("revoked-before").unwrap().is_none());
    let mut checks = 0;
    assert_eq!(
        agent
            .move_file_with_lease("revoked-after", &args, || {
                checks += 1;
                checks == 1
            })
            .unwrap()
            .state,
        "failed"
    );
    assert!(source.exists());
    assert!(!dest.exists());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // UID 0 bypasses directory DAC; this permission failure requires an ordinary user.
        if unsafe { libc::geteuid() } != 0 {
            let locked = root.path().join("no-unlink");
            fs::create_dir(&locked).unwrap();
            let locked_source = locked.join("file.txt");
            let rollback_target = root.path().join("rollback-target.txt");
            fs::write(&locked_source, "preserve").unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
            let result = agent
                .move_file_with_lease(
                    "rollback",
                    &json!({
                        "source":locked_source,"destination":rollback_target
                    }),
                    || true,
                )
                .unwrap();
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(result.state, "failed");
            assert!(locked_source.exists());
            assert!(
                !rollback_target.exists(),
                "failed unlink must remove the new hardlink"
            );
        }
    }
}
