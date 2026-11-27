use rca_native_agent::receipts::{Admission, ReceiptError, ReceiptStore};
use rusqlite::Connection;
use serde_json::json;
use std::{fs, path::Path};
use tempfile::TempDir;

fn folder(tmp: &TempDir) -> std::path::PathBuf {
    tmp.path().join("receipts")
}

fn private_write(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
fn same_id_never_reexecutes_and_different_intent_conflicts() {
    let tmp = tempfile::tempdir().unwrap();
    let directory = folder(&tmp);
    let mut store = ReceiptStore::open(&directory).unwrap();
    let args = json!({"path":"/tmp/example","content":"first"});
    assert!(matches!(
        store.admit("op-1", "write_file", &args).unwrap(),
        Admission::New(_)
    ));
    let new_receipt = store.get("op-1").unwrap().unwrap();
    assert_eq!(new_receipt.state, "admitted");
    assert!(matches!(
        store.admit("op-1", "write_file", &args).unwrap(),
        Admission::Same(_)
    ));
    assert!(matches!(
        store
            .admit(
                "op-1",
                "write_file",
                &json!({"content":"second","path":"/tmp/example"})
            )
            .unwrap(),
        Admission::Conflict(_)
    ));
    store
        .update("op-1", "completed", "Done.", None, false)
        .unwrap();
    drop(store);
    let mut reopened = ReceiptStore::open(&directory).unwrap();
    assert!(matches!(
        reopened.admit("op-1", "write_file", &args).unwrap(),
        Admission::Same(_)
    ));
    assert_eq!(reopened.get("op-1").unwrap().unwrap().state, "completed");
}

#[test]
fn interrupted_and_unknown_are_guarded_across_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let directory = folder(&tmp);
    let args = json!({"path":"/tmp/unknown"});
    {
        let mut store = ReceiptStore::open(&directory).unwrap();
        assert!(matches!(
            store.admit("op-2", "delete_file", &args).unwrap(),
            Admission::New(_)
        ));
        store
            .update("op-2", "running", "Dispatched.", None, false)
            .unwrap();
    }
    let mut store = ReceiptStore::open(&directory).unwrap();
    assert_eq!(store.get("op-2").unwrap().unwrap().state, "unknown");
    assert!(matches!(
        store.admit("op-2", "delete_file", &args).unwrap(),
        Admission::Same(_)
    ));
    assert!(matches!(
        store
            .admit("op-2", "delete_file", &json!({"path":"/tmp/other"}))
            .unwrap(),
        Admission::Conflict(_)
    ));
    store
        .update("op-2", "unknown", "Not proven.", None, false)
        .unwrap();
    drop(store);
    assert_eq!(
        ReceiptStore::open(&directory)
            .unwrap()
            .get("op-2")
            .unwrap()
            .unwrap()
            .state,
        "unknown"
    );
}

// Schema and digests captured from the retired Node ReceiptStore. This
// checks historical data preservation without retaining a second executor.
#[cfg(unix)]
#[test]
fn historical_sqlite_receipts_keep_identity_and_replay_guards() {
    let tmp = tempfile::tempdir().unwrap();
    let directory = folder(&tmp);
    fs::create_dir(&directory).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.join("operation-receipts.sqlite");
    private_write(&path, "");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE receipts (operation_id TEXT PRIMARY KEY NOT NULL, tool_name TEXT NOT NULL,
           argument_digest TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL, safe_result_summary TEXT, session_id TEXT,
           guarded INTEGER NOT NULL CHECK(guarded IN (0, 1)));
         PRAGMA user_version = 1;
         INSERT INTO receipts VALUES
           ('node-completed','write_file',
            'bb6388fa6f3543059108e65f237b2e7392feb68d0e8f244427da2cf27d7be9cd',
            'completed','2026-10-01T00:00:00.000Z','2026-10-01T00:00:01.000Z','Done.',NULL,0),
           ('node-interrupted','delete_file',
            'b3ab10d444b4c5b017d225aa3186d493fecca623f2b3956ce13aff94c58916f2',
            'running','2026-10-01T00:00:00.000Z','2026-10-01T00:00:01.000Z','Dispatched.',NULL,1),
           ('old-gui','browser_navigate',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'unknown','2026-10-01T00:00:00.000Z','2026-10-01T00:00:01.000Z',NULL,NULL,1);",
    )
    .unwrap();
    drop(db);
    let mut store = ReceiptStore::open(&directory).unwrap();
    assert_eq!(
        store.get("node-completed").unwrap().unwrap().state,
        "completed"
    );
    assert_eq!(
        store.get("node-interrupted").unwrap().unwrap().state,
        "unknown"
    );
    for (id, tool, args, changed) in [
        (
            "node-completed",
            "write_file",
            json!({"path":"/tmp/first","content":"once"}),
            json!({"path":"/tmp/second","content":"once"}),
        ),
        (
            "node-interrupted",
            "delete_file",
            json!({"path":"/tmp/unconfirmed"}),
            json!({"path":"/tmp/other"}),
        ),
    ] {
        assert!(matches!(
            store.admit(id, tool, &args).unwrap(),
            Admission::Same(_)
        ));
        assert!(matches!(
            store.admit(id, tool, &changed).unwrap(),
            Admission::Conflict(_)
        ));
    }
    assert_eq!(store.get("old-gui").unwrap().unwrap().state, "unknown");
    assert!(matches!(
        store.admit("old-gui", "browser_navigate", &json!({})),
        Err(ReceiptError::InvalidOperation)
    ));
    drop(store);
    let reopened = ReceiptStore::open(&directory).unwrap();
    assert_eq!(reopened.get("old-gui").unwrap().unwrap().state, "unknown");
    assert_eq!(
        reopened.get("node-interrupted").unwrap().unwrap().state,
        "unknown"
    );
}

#[test]
fn second_writer_cannot_claim_the_same_live_receipt_file() {
    let tmp = tempfile::tempdir().unwrap();
    let directory = folder(&tmp);
    let first = ReceiptStore::open(&directory).unwrap();
    assert!(ReceiptStore::open(&directory).is_err());
    drop(first);
    assert!(ReceiptStore::open(&directory).is_ok());
}

#[test]
fn retired_gui_tools_are_read_only_and_upgrades_remain_serial() {
    let tmp = tempfile::tempdir().unwrap();
    let directory = folder(&tmp);
    let mut store = ReceiptStore::open(&directory).unwrap();
    assert!(matches!(
        store.admit("gui", "browser_click", &json!({})),
        Err(ReceiptError::InvalidOperation)
    ));
    assert!(matches!(
        store
            .admit("up-1", "upgrade_agent", &json!({"version":"test"}))
            .unwrap(),
        Admission::New(_)
    ));
    assert!(matches!(
        store
            .admit("up-2", "upgrade_agent", &json!({"version":"test"}))
            .unwrap(),
        Admission::Full
    ));
}

#[test]
fn previous_json_history_is_migrated_and_never_replayed() {
    let tmp = tempfile::tempdir().unwrap();
    let directory = folder(&tmp);
    fs::create_dir(&directory).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let historical = json!({
        "version":1,
        "receipts":[{
            "operation_id":"old-1","tool_name":"browser_click",
            "argument_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "state":"running","created_at":"2026-10-01T00:00:00.000Z",
            "updated_at":"2026-10-01T00:00:01.000Z"
        },{
            "operation_id":"old-2","tool_name":"write_file",
            "argument_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "state":"unknown","created_at":"2026-10-01T00:00:00.000Z",
            "updated_at":"2026-10-01T00:00:01.000Z"
        }]
    });
    let text = historical.to_string();
    private_write(&directory.join("operation-receipts.json"), &text);
    let store = ReceiptStore::open(&directory).unwrap();
    assert_eq!(store.get("old-1").unwrap().unwrap().state, "unknown");
    assert_eq!(store.get("old-2").unwrap().unwrap().state, "unknown");
    assert_eq!(
        fs::read_to_string(directory.join("operation-receipts.pre-sqlite.json")).unwrap(),
        text
    );
    assert_eq!(
        fs::read_to_string(directory.join("operation-receipts.json")).unwrap(),
        text
    );
}

#[test]
fn unrecognized_schema_and_unsafe_state_path_fail_closed() {
    let tmp = tempfile::tempdir().unwrap();
    let directory = folder(&tmp);
    let store = ReceiptStore::open(&directory).unwrap();
    drop(store);
    let sqlite = directory.join("operation-receipts.sqlite");
    let db = Connection::open(&sqlite).unwrap();
    db.pragma_update(None, "user_version", 2).unwrap();
    drop(db);
    assert!(matches!(
        ReceiptStore::open(&directory),
        Err(ReceiptError::Incompatible)
    ));

    let tmp2 = tempfile::tempdir().unwrap();
    let dir2 = folder(&tmp2);
    fs::create_dir(&dir2).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir2, fs::Permissions::from_mode(0o777)).unwrap();
    }
    assert!(matches!(
        ReceiptStore::open(&dir2),
        Err(ReceiptError::UnsafePath)
    ));
}

#[test]
fn normal_receipt_queries_expire_only_eligible_history_after_lossless_open() {
    use rca_native_agent::native_write::NativeWriteExecutor;
    let tmp = tempfile::tempdir().unwrap();
    let directory = folder(&tmp);
    {
        let mut store = ReceiptStore::open(&directory).unwrap();
        for (id, tool, state, known_no_effect) in [
            ("ordinary", "write_file", "completed", false),
            ("no-effect", "delete_file", "failed", true),
            ("uncertain", "write_file", "unknown", false),
            ("effectful", "start_process", "failed", false),
            ("upgrade", "upgrade_agent", "completed", false),
            ("recent", "write_file", "completed", false),
        ] {
            assert!(matches!(
                store.admit(id, tool, &json!({})).unwrap(),
                Admission::New(_)
            ));
            store
                .update(id, state, "bounded summary", None, known_no_effect)
                .unwrap();
        }
    }
    let db = Connection::open(directory.join("operation-receipts.sqlite")).unwrap();
    db.execute("UPDATE receipts SET created_at = '2000-01-01T00:00:00.000Z' WHERE operation_id != 'recent'", []).unwrap();
    drop(db);
    // Merely opening the store (including a migration/restart) cannot prune
    // original history. Ordinary runtime admission/query may apply retention.
    {
        let store = ReceiptStore::open(&directory).unwrap();
        for id in [
            "ordinary",
            "no-effect",
            "uncertain",
            "effectful",
            "upgrade",
            "recent",
        ] {
            assert!(store.get(id).unwrap().is_some(), "{id}");
        }
    }
    let writer = NativeWriteExecutor::open(&directory).unwrap();
    assert!(writer.get_receipt("ordinary").unwrap().is_none());
    assert!(writer.get_receipt("no-effect").unwrap().is_none());
    for (id, state) in [
        ("uncertain", "unknown"),
        ("effectful", "failed"),
        ("upgrade", "completed"),
        ("recent", "completed"),
    ] {
        let receipt = writer.get_receipt(id).unwrap().unwrap();
        assert_eq!(receipt.state, state);
        assert_eq!(receipt.operation_id, id);
        if matches!(id, "uncertain" | "effectful") {
            assert!(receipt.safe_result_summary.is_none());
        } else {
            assert!(receipt.safe_result_summary.is_some());
        }
    }
    drop(writer);
    let mut store = ReceiptStore::open(&directory).unwrap();
    assert!(matches!(
        store.admit("uncertain", "write_file", &json!({})).unwrap(),
        Admission::Same(_)
    ));
    assert!(matches!(
        store
            .admit("uncertain", "write_file", &json!({"changed":true}))
            .unwrap(),
        Admission::Conflict(_)
    ));
    assert!(matches!(
        store.admit("upgrade", "upgrade_agent", &json!({})).unwrap(),
        Admission::Same(_)
    ));
}
