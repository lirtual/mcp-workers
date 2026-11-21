//! Windows receipt persistence must fail closed until owner-private ACLs are verified.
//! The test uses only a disposable temporary directory, never an Agent profile.
#![cfg(windows)]

use rca_native_agent::receipts::{ReceiptError, ReceiptStore};

#[test]
fn unchecked_windows_acl_refuses_receipts_before_creating_sqlite() {
    let root = tempfile::tempdir().unwrap();
    let receipts = root.path().join("receipts");
    assert!(matches!(
        ReceiptStore::open(&receipts),
        Err(ReceiptError::UnsafePath)
    ));
    assert!(!receipts.join("operation-receipts.sqlite").exists());
}
