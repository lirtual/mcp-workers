//! Independent Node write_file contract cases. No production device or Worker.
use rca_native_agent::native_write::{NativeWriteError, NativeWriteExecutor};
use rca_native_agent::receipts::ReceiptStore;
use serde_json::json;
use std::fs;

fn executor(root: &tempfile::TempDir) -> NativeWriteExecutor {
    NativeWriteExecutor::open(&root.path().join("receipts")).unwrap()
}

#[test]
fn invalid_arguments_fail_before_admission_or_effect() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("contents.txt");
    let mut writer = executor(&root);
    for args in [
        json!({"path":target,"content":"x","mode":"overwrite"}),
        json!({"path":target,"content":"x","mode":"rewrite","extra":true}),
        json!({"path":target,"content":"\u{0000}","mode":"rewrite"}),
        json!({"path":"https://example.test/x","content":"x","mode":"rewrite"}),
        json!({"path":"//device/special","content":"x","mode":"rewrite"}),
        json!({"path":target,"content":"x".repeat(49_153),"mode":"rewrite"}),
    ] {
        assert!(matches!(
            writer.write_file("bad-id", &args),
            Err(NativeWriteError::InvalidInput)
        ));
        assert!(writer.get_receipt("bad-id").unwrap().is_none());
    }
    assert!(!target.exists());
}

#[test]
fn rewrite_existing_and_append_keep_hardlink_inode_and_no_replay() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("existing.txt");
    let alias = root.path().join("hard.txt");
    fs::write(&file, "before").unwrap();
    fs::hard_link(&file, &alias).unwrap();
    let before = fs::metadata(&file).unwrap();
    let mut writer = executor(&root);
    let original = json!({"path":file,"content":"after","mode":"rewrite"});
    assert_eq!(
        writer.write_file("rewrite-once", &original).unwrap().state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&alias).unwrap(), "after");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(fs::metadata(&file).unwrap().ino(), before.ino());
    }
    // Path lexical normalization occurs before digest, even for existing receipts.
    let normalized =
        json!({"path":root.path().join("./existing.txt"),"content":"after","mode":"rewrite"});
    assert_eq!(
        writer
            .write_file("rewrite-once", &normalized)
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(
        writer
            .write_file(
                "rewrite-once",
                &json!({"path":file,"content":"changed","mode":"rewrite"})
            )
            .unwrap()
            .state,
        "conflict"
    );
    let append = json!({"path":file,"content":"!","mode":"append"});
    assert_eq!(
        writer.write_file("append-once", &append).unwrap().state,
        "completed"
    );
    assert_eq!(
        writer.write_file("append-once", &append).unwrap().state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "after!");
    drop(writer);
    let mut restarted = executor(&root);
    assert_eq!(
        restarted.write_file("append-once", &append).unwrap().state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "after!");
}

#[cfg(unix)]
#[test]
fn symlink_rewrite_preserves_original_target_and_private_mode() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("existing.txt");
    let alias = root.path().join("symlink.txt");
    fs::write(&file, "before").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&file, &alias).unwrap();
    let before = fs::metadata(&file).unwrap();
    let mut writer = executor(&root);
    assert_eq!(
        writer
            .write_file(
                "symlink",
                &json!({"path":alias,"content":"changed","mode":"rewrite"})
            )
            .unwrap()
            .state,
        "completed"
    );
    let after = fs::metadata(&file).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "changed");
    assert_eq!(after.ino(), before.ino());
    assert_eq!(after.permissions().mode() & 0o777, 0o600);
}

#[test]
fn missing_parent_is_known_no_effect_and_never_replayed() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("absent").join("file.txt");
    let mut writer = executor(&root);
    let args = json!({"path":file,"content":"payload","mode":"rewrite"});
    assert_eq!(
        writer.write_file("known-fail", &args).unwrap().state,
        "failed"
    );
    fs::create_dir(root.path().join("absent")).unwrap();
    assert_eq!(
        writer.write_file("known-fail", &args).unwrap().state,
        "failed"
    );
    assert!(!file.exists());
}

#[test]
fn interrupted_receipt_is_unknown_and_cannot_replay_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("guarded.txt");
    let args = json!({"path":file,"content":"blocked","mode":"append"});
    let mut receipts = ReceiptStore::open(&root.path().join("receipts")).unwrap();
    receipts.admit("unfinished", "write_file", &args).unwrap();
    receipts
        .update("unfinished", "running", "in flight", None, false)
        .unwrap();
    drop(receipts);
    let mut writer = executor(&root);
    assert_eq!(
        writer.write_file("unfinished", &args).unwrap().state,
        "unknown"
    );
    assert!(!file.exists());
}

#[test]
fn success_keeps_arguments_out_of_persisted_receipts() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("new.txt");
    let secret = "secret-message-from-owner";
    let mut writer = executor(&root);
    assert_eq!(
        writer
            .write_file(
                "create",
                &json!({"path":target,"content":secret,"mode":"rewrite"})
            )
            .unwrap()
            .state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), secret);
    let db = fs::read(root.path().join("receipts/operation-receipts.sqlite")).unwrap();
    assert!(!db
        .windows(secret.len())
        .any(|chunk| chunk == secret.as_bytes()));
    assert_eq!(
        writer.get_receipt("create").unwrap().unwrap().tool_name,
        "write_file"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn creates_new_file_with_node_default_permissions_and_exact_utf8_byte_limit() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("new.txt");
    let mut writer = executor(&root);
    let content = "测".repeat(16_384); // exactly 49,152 encoded bytes
    let args = json!({"path":target,"content":content,"mode":"rewrite"});
    assert_eq!(
        writer.write_file("utf8-limit", &args).unwrap().state,
        "completed"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), content);
    let status = fs::read_to_string("/proc/self/status").unwrap();
    let mask = status
        .lines()
        .find_map(|line| line.strip_prefix("Umask:\t"))
        .and_then(|raw| u32::from_str_radix(raw.trim(), 8).ok())
        .unwrap();
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o666 & !mask
    );
}

#[test]
fn conflicting_tool_receipt_does_not_execute_file_write() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("would-write.txt");
    let mut receipts = ReceiptStore::open(&root.path().join("receipts")).unwrap();
    receipts
        .admit("shared-op", "create_directory", &json!({"path":target}))
        .unwrap();
    drop(receipts);
    let mut writer = executor(&root);
    assert_eq!(
        writer
            .write_file(
                "shared-op",
                &json!({"path":target,"content":"x","mode":"rewrite"})
            )
            .unwrap()
            .state,
        "conflict"
    );
    assert!(!target.exists());
}
