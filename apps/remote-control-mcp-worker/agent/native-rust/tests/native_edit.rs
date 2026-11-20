//! Native exact-text edit: count, UTF-8, inode, receipt, and lease invariants.
use rca_native_agent::native_write::{NativeWriteError, NativeWriteExecutor};
use serde_json::json;
use std::fs;

#[test]
fn edit_block_replaces_exact_nonoverlapping_occurrences_and_never_replays() {
    let root = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    let target = root.path().join("file.txt");
    fs::write(&target, "hello hello\n👋 hello").unwrap();
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(&target).unwrap().ino()
    };
    let arguments = json!({"file_path":target,"old_string":"hello",
        "new_string":"你好","expected_replacements":3});
    let mut agent = NativeWriteExecutor::open(&receipts).unwrap();
    assert_eq!(
        agent
            .edit_block_with_lease("edit-1", &arguments, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "你好 你好\n👋 你好");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(fs::metadata(&target).unwrap().ino(), inode);
    }
    fs::write(&target, "hello restored").unwrap();
    assert_eq!(
        agent
            .edit_block_with_lease("edit-1", &arguments, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello restored");
    assert_eq!(
        agent
            .edit_block_with_lease(
                "edit-1",
                &json!({
                    "file_path":target,"old_string":"hello","new_string":"different",
                    "expected_replacements":3
                }),
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
            .edit_block_with_lease("edit-1", &arguments, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "hello restored");
    assert_eq!(
        restarted.get_receipt("edit-1").unwrap().unwrap().tool_name,
        "edit_block"
    );
}

#[test]
fn edit_mismatch_invalid_utf8_missing_and_invalid_args_leave_target_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let mut agent = NativeWriteExecutor::open(&root.path().join("receipts")).unwrap();
    let target = root.path().join("raw.txt");
    fs::write(&target, "abc abc").unwrap();
    let mismatch = json!({"file_path":target,"old_string":"abc","new_string":"changed",
        "expected_replacements":1});
    let result = agent
        .edit_block_with_lease("count", &mismatch, || true)
        .unwrap();
    assert_eq!(result.state, "failed");
    assert_eq!(
        result.receipt.unwrap().safe_result_summary.as_deref(),
        Some("Expected text replacement count did not match.")
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "abc abc");

    let default_one = json!({"file_path":target,"old_string":"abc","new_string":"changed"});
    assert_eq!(
        agent
            .edit_block_with_lease("default", &default_one, || true)
            .unwrap()
            .state,
        "failed"
    );
    fs::write(&target, [0x61, 0xff, 0x62]).unwrap();
    let result = agent
        .edit_block_with_lease(
            "utf8",
            &json!({
                "file_path":target,"old_string":"a","new_string":"changed"
            }),
            || true,
        )
        .unwrap();
    assert_eq!(result.state, "failed");
    assert_eq!(
        result.receipt.unwrap().safe_result_summary.as_deref(),
        Some("The file is not valid UTF-8 text.")
    );
    assert_eq!(fs::read(&target).unwrap(), [0x61, 0xff, 0x62]);
    let missing = root.path().join("missing");
    assert_eq!(
        agent
            .edit_block_with_lease(
                "missing",
                &json!({
                    "file_path":missing,"old_string":"before","new_string":"after"
                }),
                || true
            )
            .unwrap()
            .state,
        "failed"
    );
    assert!(!missing.exists());

    for invalid in [
        json!({"file_path":target,"old_string":"","new_string":"x"}),
        json!({"file_path":target,"old_string":"a","new_string":"x","expected_replacements":0}),
        json!({"file_path":target,"old_string":"a","new_string":"x","expected_replacements":1001}),
        json!({"file_path":target,"old_string":"a","new_string":"x","unexpected":1}),
        json!({"file_path":target,"old_string":"a","new_string":"x","expected_replacements":1.5}),
        json!({"file_path":target,"old_string":"a","new_string":"\u{0000}"}),
        json!({"file_path":"file:///tmp/a","old_string":"a","new_string":"x"}),
    ] {
        assert!(matches!(
            agent.edit_block_with_lease("invalid", &invalid, || true),
            Err(NativeWriteError::InvalidInput)
        ));
    }
    assert!(agent.get_receipt("invalid").unwrap().is_none());
}

#[test]
fn edit_revoked_lease_before_and_after_admission_preserves_source() {
    let root = tempfile::tempdir().unwrap();
    let mut agent = NativeWriteExecutor::open(&root.path().join("receipts")).unwrap();
    let target = root.path().join("file.txt");
    fs::write(&target, "before").unwrap();
    let args = json!({"file_path":target,"old_string":"before","new_string":"after"});
    assert!(matches!(
        agent.edit_block_with_lease("before", &args, || false),
        Err(NativeWriteError::LeaseRevoked)
    ));
    assert!(agent.get_receipt("before").unwrap().is_none());
    let mut checks = 0;
    assert_eq!(
        agent
            .edit_block_with_lease("after", &args, || {
                checks += 1;
                checks == 1
            })
            .unwrap()
            .state,
        "failed"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "before");
}

#[cfg(unix)]
#[test]
fn edit_preserves_symlink_hardlink_and_open_handle_identity() {
    use std::io::{Read, Seek, SeekFrom};
    use std::os::unix::fs::MetadataExt;

    let root = tempfile::tempdir().unwrap();
    let mut agent = NativeWriteExecutor::open(&root.path().join("receipts")).unwrap();
    let target = root.path().join("target.txt");
    let hardlink = root.path().join("other-name.txt");
    let symlink = root.path().join("source-link.txt");
    fs::write(&target, "one two one").unwrap();
    fs::hard_link(&target, &hardlink).unwrap();
    std::os::unix::fs::symlink(&target, &symlink).unwrap();
    let mut open = fs::File::open(&target).unwrap();
    let inode = open.metadata().unwrap().ino();

    let outcome = agent
        .edit_block_with_lease(
            "edit-through-symlink",
            &json!({"file_path":symlink,"old_string":"one","new_string":"three",
            "expected_replacements":2}),
            || true,
        )
        .unwrap();
    assert_eq!(outcome.state, "completed");
    assert_eq!(fs::read_to_string(&target).unwrap(), "three two three");
    assert_eq!(fs::read_to_string(&hardlink).unwrap(), "three two three");
    assert_eq!(fs::read_to_string(&symlink).unwrap(), "three two three");
    assert!(fs::symlink_metadata(&symlink)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::metadata(&target).unwrap().ino(), inode);
    open.seek(SeekFrom::Start(0)).unwrap();
    let mut visible = String::new();
    open.read_to_string(&mut visible).unwrap();
    assert_eq!(visible, "three two three");
}

#[test]
fn edit_default_count_and_explicit_one_share_canonical_receipt() {
    let root = tempfile::tempdir().unwrap();
    let mut agent = NativeWriteExecutor::open(&root.path().join("receipts")).unwrap();
    let target = root.path().join("file.txt");
    fs::write(&target, "single").unwrap();
    let implicit = json!({"file_path":target,"old_string":"single","new_string":"updated"});
    assert_eq!(
        agent
            .edit_block_with_lease("same-normalized", &implicit, || true)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(
        agent
            .edit_block_with_lease(
                "same-normalized",
                &json!({
                    "file_path":target,"old_string":"single","new_string":"updated",
                    "expected_replacements":1
                }),
                || true
            )
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "updated");
    assert_eq!(
        agent
            .write_file_with_lease(
                "same-normalized",
                &json!({
                    "path":target,"content":"cross-tool-must-not-write","mode":"rewrite"
                }),
                || true
            )
            .unwrap()
            .state,
        "conflict"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "updated");
}
