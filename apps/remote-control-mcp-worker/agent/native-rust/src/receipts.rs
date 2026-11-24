//! SQLite receipt seam for the Node Agent's user_version=1 schema.
//! An admitted external effect may not be blindly replayed after restart.
//! The disposable Gate0Probe is the only caller allowed to trigger a file effect.
use crate::digest::operation_digest;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use thiserror::Error;

const ACTIVE_TOOLS: &[&str] = &[
    "write_file",
    "create_directory",
    "edit_block",
    "move_file",
    "delete_file",
    "start_process",
    "interact_with_process",
    "force_terminate",
    "upgrade_agent",
];
const HISTORICAL_TOOLS: &[&str] = &[
    "browser_start",
    "browser_navigate",
    "browser_close",
    "browser_tabs",
    "browser_click",
    "browser_fill",
    "browser_press_key",
    "browser_select_option",
    "computer_stop",
];
const STATES: &[&str] = &["admitted", "running", "completed", "failed", "unknown"];

#[derive(Debug, Error)]
pub enum ReceiptError {
    #[error("receipt persistence unavailable: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("receipt file unavailable: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported or conflicting receipt state")]
    Incompatible,
    #[error("receipt state directory or file is not private to this account")]
    UnsafePath,
    #[error("invalid operation identity or tool")]
    InvalidOperation,
    #[error("receipt not found")]
    NotFound,
    #[error("receipt storage disabled for this runtime")]
    Unavailable,
    #[error("exclusive receipt ownership cannot be established")]
    Ownership,
    #[error("effect outcome could not be persisted")]
    AfterEffect(Box<ReceiptError>),
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Receipt {
    pub operation_id: String,
    pub tool_name: String,
    pub argument_digest: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub safe_result_summary: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Deserialize)]
struct LegacyData {
    version: u32,
    receipts: Vec<Receipt>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    New(Receipt),
    Same(Receipt),
    Conflict(Receipt),
    Full,
}

pub struct ReceiptStore {
    connection: Connection,
    available: Arc<AtomicBool>,
    pub directory: PathBuf,
    pub(crate) session_activity: Option<crate::session_idle::Activity>,
}

pub(crate) fn valid_id(id: &str) -> bool {
    ![".", ".."].contains(&id)
        && (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_legacy(receipt: &Receipt) -> bool {
    valid_id(&receipt.operation_id)
        && (ACTIVE_TOOLS.contains(&receipt.tool_name.as_str())
            || HISTORICAL_TOOLS.contains(&receipt.tool_name.as_str()))
        && valid_digest(&receipt.argument_digest)
        && STATES.contains(&receipt.state.as_str())
        && !receipt.created_at.is_empty()
        && !receipt.updated_at.is_empty()
}

fn parse_legacy(bytes: &[u8]) -> Result<Vec<Receipt>, ReceiptError> {
    let data: LegacyData = serde_json::from_slice(bytes).map_err(|_| ReceiptError::Incompatible)?;
    if data.version != 1 {
        return Err(ReceiptError::Incompatible);
    }
    let mut seen = std::collections::HashSet::new();
    for r in &data.receipts {
        if !valid_legacy(r) || !seen.insert(&r.operation_id) {
            return Err(ReceiptError::Incompatible);
        }
    }
    Ok(data.receipts)
}

fn iso_now(conn: &Connection) -> Result<String, ReceiptError> {
    Ok(
        conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })?,
    )
}

#[cfg(unix)]
fn private_path(path: &Path, is_dir: bool) -> Result<(), ReceiptError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink()
        || (is_dir && !meta.is_dir())
        || (!is_dir && !meta.is_file())
        || meta.permissions().mode() & 0o077 != 0
        || meta.uid() != unsafe { libc::geteuid() }
    {
        return Err(ReceiptError::UnsafePath);
    }
    Ok(())
}

#[cfg(windows)]
fn private_path(path: &Path, is_dir: bool) -> Result<(), ReceiptError> {
    crate::windows_private::private_path(path, is_dir)
}

#[cfg(not(any(unix, windows)))]
fn private_path(_path: &Path, _is_dir: bool) -> Result<(), ReceiptError> {
    Err(ReceiptError::UnsafePath)
}

fn private_directory(directory: &Path) -> Result<(), ReceiptError> {
    if !directory.exists() {
        #[cfg(windows)]
        private_path(directory.parent().ok_or(ReceiptError::UnsafePath)?, true)?;
        fs::create_dir(directory)?;
        #[cfg(windows)]
        crate::windows_private::seal_new_owner(directory, true)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }
    }
    private_path(directory, true)
}

fn prepare_db_file(path: &Path) -> Result<(), ReceiptError> {
    if !path.exists() {
        let mut open = OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(0o600);
        }
        match open.open(path) {
            Ok(file) => {
                #[cfg(windows)]
                crate::windows_private::seal_new_owner(path, false)?;
                file.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        };
    }
    private_path(path, false)
}

fn preserve_legacy(directory: &Path, original: &[u8]) -> Result<(), ReceiptError> {
    let backup = directory.join("operation-receipts.pre-sqlite.json");
    if backup.exists() {
        private_path(&backup, false)?;
        if fs::read(&backup)? != original {
            return Err(ReceiptError::Incompatible);
        }
        return Ok(());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&backup)?;
    #[cfg(windows)]
    crate::windows_private::seal_new_owner(&backup, false)?;
    file.write_all(original)?;
    file.sync_all()?;
    private_path(&backup, false)
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Receipt> {
    Ok(Receipt {
        operation_id: row.get("operation_id")?,
        tool_name: row.get("tool_name")?,
        argument_digest: row.get("argument_digest")?,
        state: row.get("state")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        safe_result_summary: row.get("safe_result_summary")?,
        session_id: row.get("session_id")?,
    })
}

fn read_row(conn: &Connection, id: &str) -> Result<Option<Receipt>, ReceiptError> {
    Ok(conn
        .query_row(
            "SELECT * FROM receipts WHERE operation_id = ?1",
            [id],
            from_row,
        )
        .optional()?)
}

// Only ordinary, conclusively terminal history expires. This is normal
// runtime maintenance, never part of opening/migrating an existing ledger.
// Keep protected identity/digest/state and any session association that may
// still be needed for recovery. No timer, schema change or extra database.
fn cleanup_expired(conn: &Connection) -> Result<(), ReceiptError> {
    let cutoff: String = conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')",
        [],
        |row| row.get(0),
    )?;
    conn.execute(
        "DELETE FROM receipts WHERE guarded=0 AND tool_name!='upgrade_agent'
         AND state IN ('completed','failed') AND created_at < ?1",
        [&cutoff],
    )?;
    conn.execute(
        "UPDATE receipts SET safe_result_summary=NULL
         WHERE guarded=1 AND tool_name!='upgrade_agent'
         AND state IN ('completed','failed','unknown')
         AND created_at < ?1 AND safe_result_summary IS NOT NULL",
        [&cutoff],
    )?;
    Ok(())
}

impl ReceiptError {
    pub(crate) fn after_effect(self) -> Self {
        Self::AfterEffect(Box::new(self))
    }

    fn cause(&self) -> &Self {
        match self {
            Self::AfterEffect(error) => error.cause(),
            _ => self,
        }
    }

    pub(crate) fn diagnostic(&self) -> &'static str {
        use rusqlite::ErrorCode::*;
        match self.cause() {
            Self::UnsafePath => "receipt_unsafe_path",
            Self::Ownership => "receipt_owner_unavailable",
            Self::Incompatible => "receipt_incompatible",
            Self::Sqlite(rusqlite::Error::SqliteFailure(error, _))
                if matches!(
                    error.extended_code,
                    rusqlite::ffi::SQLITE_IOERR_LOCK
                        | rusqlite::ffi::SQLITE_IOERR_UNLOCK
                        | rusqlite::ffi::SQLITE_IOERR_RDLOCK
                        | rusqlite::ffi::SQLITE_IOERR_CHECKRESERVEDLOCK
                        | rusqlite::ffi::SQLITE_IOERR_SHMLOCK
                ) =>
            {
                "receipt_owner_unavailable"
            }
            Self::Sqlite(rusqlite::Error::SqliteFailure(error, _)) => match error.code {
                DatabaseBusy | DatabaseLocked | FileLockingProtocolFailed => {
                    "receipt_owner_unavailable"
                }
                DatabaseCorrupt | NotADatabase => "receipt_corrupt",
                ReadOnly | PermissionDenied => "receipt_readonly",
                DiskFull => "receipt_full",
                _ => "receipt_storage_unavailable",
            },
            Self::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                "receipt_readonly"
            }
            _ => "receipt_storage_unavailable",
        }
    }

    fn startup_storage_failure(&self) -> bool {
        use rusqlite::ErrorCode::*;
        matches!(self, Self::Sqlite(rusqlite::Error::SqliteFailure(error, _))
            if matches!(error.code, DatabaseCorrupt | NotADatabase | DiskFull | ReadOnly))
    }
}

// A degraded runtime never opens a replacement ledger. A fresh, SQL-unused
// SQLite connection holds the same database-file locks without parsing a
// damaged header. No SQL may run on this connection after direct VFS locking.
fn lock_unreadable_database(path: &Path) -> Result<Connection, ReceiptError> {
    use rusqlite::ffi;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )?;
    // SAFETY: the connection has no prepared statements, SQL transactions
    // or other users. The file and methods belong to the live connection;
    // no pointer escapes. SQLite closes its own file and releases its locks.
    unsafe {
        let mut file: *mut ffi::sqlite3_file = std::ptr::null_mut();
        let rc = ffi::sqlite3_file_control(
            connection.handle(),
            c"main".as_ptr(),
            ffi::SQLITE_FCNTL_FILE_POINTER,
            (&mut file as *mut *mut ffi::sqlite3_file).cast(),
        );
        if rc != ffi::SQLITE_OK || file.is_null() || (*file).pMethods.is_null() {
            return Err(ReceiptError::Ownership);
        }
        let lock = (*(*file).pMethods).xLock.ok_or(ReceiptError::Ownership)?;
        for level in [
            ffi::SQLITE_LOCK_SHARED,
            ffi::SQLITE_LOCK_RESERVED,
            ffi::SQLITE_LOCK_EXCLUSIVE,
        ] {
            if lock(file, level) != ffi::SQLITE_OK {
                return Err(ReceiptError::Ownership);
            }
        }
    }
    verify_exclusive(&connection)?;
    Ok(connection)
}

fn verify_exclusive(connection: &Connection) -> Result<(), ReceiptError> {
    use rusqlite::ffi;
    let mut state = ffi::SQLITE_LOCK_NONE;
    // SAFETY: synchronous query of the live connection's VFS lock state.
    let rc = unsafe {
        ffi::sqlite3_file_control(
            connection.handle(),
            c"main".as_ptr(),
            ffi::SQLITE_FCNTL_LOCKSTATE,
            (&mut state as *mut i32).cast(),
        )
    };
    if rc != ffi::SQLITE_OK || state != ffi::SQLITE_LOCK_EXCLUSIVE {
        return Err(ReceiptError::Ownership);
    }
    Ok(())
}

impl ReceiptStore {
    /// Refuses nonprivate directories, unfamiliar versions and concurrent writers.
    pub fn open(directory: &Path) -> Result<Self, ReceiptError> {
        Self::open_with_historical(directory, None)
    }

    /// Network runtime may degrade only while holding the original exclusive
    /// lock. Offline migration and probe callers remain strict.
    pub(crate) fn open_runtime(
        directory: &Path,
        notify: impl FnOnce(&'static str),
    ) -> Result<Self, ReceiptError> {
        match Self::open(directory) {
            Ok(store) => Ok(store),
            Err(error) if error.startup_storage_failure() => {
                private_path(directory, true)?;
                let db_path = directory.join("operation-receipts.sqlite");
                private_path(&db_path, false)?;
                for suffix in ["-wal", "-shm"] {
                    let sidecar = directory.join(format!("operation-receipts.sqlite{suffix}"));
                    match fs::symlink_metadata(sidecar) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        _ => return Err(ReceiptError::Ownership),
                    }
                }
                let connection = lock_unreadable_database(&db_path)?;
                notify(error.diagnostic());
                Ok(Self {
                    connection,
                    available: Arc::new(AtomicBool::new(false)),
                    directory: directory.to_owned(),
                    session_activity: None,
                })
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn available(&self) -> bool {
        self.available.load(Ordering::Acquire)
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub(crate) fn health(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.available)
    }

    /// Latch failure for this owner; no repair, retries or new effects.
    pub(crate) fn isolate(&mut self, error: &ReceiptError) -> Result<bool, ReceiptError> {
        let was_available = self.available.swap(false, Ordering::AcqRel);
        if matches!(
            error.cause(),
            ReceiptError::UnsafePath
                | ReceiptError::Ownership
                | ReceiptError::Incompatible
                | ReceiptError::InvalidOperation
        ) || error.diagnostic() == "receipt_owner_unavailable"
        {
            return Err(ReceiptError::Ownership);
        }
        if was_available {
            private_path(&self.directory, true)?;
            private_path(&self.directory.join("operation-receipts.sqlite"), false)?;
            verify_exclusive(&self.connection)?;
        }
        Ok(was_available)
    }

    fn require_available(&self) -> Result<(), ReceiptError> {
        if self.available() {
            Ok(())
        } else {
            Err(ReceiptError::Unavailable)
        }
    }

    /// Operator-selected legacy history only: never guess a backup file.
    pub fn open_with_historical(
        directory: &Path,
        historical_path: Option<&Path>,
    ) -> Result<Self, ReceiptError> {
        private_directory(directory)?;
        let db_path = directory.join("operation-receipts.sqlite");
        prepare_db_file(&db_path)?;
        let mut connection = Connection::open_with_flags(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )?;
        connection.busy_timeout(std::time::Duration::ZERO)?;
        connection.execute_batch("PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL;")?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != 0 && version != 1 {
            return Err(ReceiptError::Incompatible);
        }
        if version == 0 {
            let table_count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='receipts'",
                [],
                |r| r.get(0),
            )?;
            if table_count != 0 {
                return Err(ReceiptError::Incompatible);
            }

            let old_path = directory.join("operation-receipts.json");
            let mut records: Vec<Receipt> = Vec::new();
            if old_path.exists() {
                private_path(&old_path, false)?;
                let original = fs::read(&old_path)?;
                let current = parse_legacy(&original)?;
                let historical = if let Some(source) = historical_path {
                    if !source.is_absolute() {
                        return Err(ReceiptError::Incompatible);
                    }
                    private_path(source, false)?;
                    parse_legacy(&fs::read(source)?)?
                } else {
                    Vec::new()
                };
                if historical_path.is_some() && historical.len() < current.len() {
                    return Err(ReceiptError::Incompatible);
                }
                let mut merged: HashMap<String, Receipt> = historical
                    .into_iter()
                    .map(|r| (r.operation_id.clone(), r))
                    .collect();
                for r in current {
                    if let Some(previous) = merged.get(&r.operation_id) {
                        if previous.tool_name != r.tool_name
                            || previous.argument_digest != r.argument_digest
                            || previous.created_at != r.created_at
                        {
                            return Err(ReceiptError::Incompatible);
                        }
                    }
                    let mut chosen = r;
                    if let Some(previous) = merged.get(&chosen.operation_id) {
                        if (previous.state == "unknown" || previous.state == "failed")
                            && previous.state != chosen.state
                        {
                            chosen.state = "unknown".into();
                            chosen.safe_result_summary =
                                Some("Effect needs operator reconciliation.".into());
                        }
                    }
                    merged.insert(chosen.operation_id.clone(), chosen);
                }
                records = merged.into_values().collect();
                preserve_legacy(directory, &original)?;
                if fs::read(&old_path)? != original {
                    return Err(ReceiptError::Incompatible);
                }
            } else if historical_path.is_some() {
                return Err(ReceiptError::Incompatible);
            }

            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(
                "CREATE TABLE receipts (
                    operation_id TEXT PRIMARY KEY NOT NULL,
                    tool_name TEXT NOT NULL,
                    argument_digest TEXT NOT NULL,
                    state TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    safe_result_summary TEXT,
                    session_id TEXT,
                    guarded INTEGER NOT NULL CHECK(guarded IN (0,1))
                );",
            )?;
            for r in records {
                let interrupted = r.state == "admitted" || r.state == "running";
                let state = if interrupted { "unknown" } else { &r.state };
                let guarded = state == "unknown" || state == "failed";
                tx.execute(
                    "INSERT INTO receipts VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,?8)",
                    params![
                        r.operation_id,
                        r.tool_name,
                        r.argument_digest,
                        state,
                        r.created_at,
                        iso_now(&tx)?,
                        if interrupted {
                            Some("Effect cannot be established after restart.".to_owned())
                        } else {
                            r.safe_result_summary.map(|s| s.chars().take(128).collect())
                        },
                        if guarded { 1 } else { 0 }
                    ],
                )?;
            }
            tx.execute_batch("PRAGMA user_version = 1;")?;
            tx.commit()?;
        }
        // Claim exclusive ownership BEFORE admitting remote work. SQLite does not
        // prove OS process ownership: the legacy owner must also be stopped.
        connection
            .query_row("SELECT operation_id FROM receipts LIMIT 1", [], |_r| Ok(()))
            .optional()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE receipts SET state='unknown', guarded=1, session_id=NULL,
             safe_result_summary='Effect cannot be established after restart.'
             WHERE state IN ('admitted','running')",
            [],
        )?;
        tx.execute(
            "UPDATE receipts SET session_id=NULL WHERE tool_name IN
             ('start_process','interact_with_process','force_terminate')",
            [],
        )?;
        tx.commit()?;
        Ok(Self {
            connection,
            available: Arc::new(AtomicBool::new(true)),
            directory: directory.to_owned(),
            session_activity: None,
        })
    }

    /// Only ephemeral Sessions need idle evidence. A recovered interrupted
    /// operation must not become proven idle just because the process restarted.
    pub(crate) fn enable_session_activity(&mut self) -> Result<(), ReceiptError> {
        let mut activity = crate::session_idle::Activity::default();
        if self.available() {
            let uncertain: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM receipts WHERE state IN ('admitted','running','unknown'))",
                [], |row| row.get(0),
            )?;
            if uncertain {
                activity.mark_unknown();
            }
        } else {
            activity.mark_unknown();
        }
        self.session_activity = Some(activity);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<Receipt>, ReceiptError> {
        self.require_available()?;
        if !valid_id(id) {
            return Err(ReceiptError::InvalidOperation);
        }
        read_row(&self.connection, id)
    }

    /// Runtime status lookup uses the established retention policy. Internal
    /// recovery and migration verification keep using the lossless lookup.
    pub(crate) fn query_runtime(&self, id: &str) -> Result<Option<Receipt>, ReceiptError> {
        self.require_available()?;
        if !valid_id(id) {
            return Err(ReceiptError::InvalidOperation);
        }
        let tx = self.connection.unchecked_transaction()?;
        cleanup_expired(&tx)?;
        let result = read_row(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn admit(
        &mut self,
        id: &str,
        tool: &str,
        arguments: &Value,
    ) -> Result<Admission, ReceiptError> {
        self.require_available()?;
        if !valid_id(id) || !ACTIVE_TOOLS.contains(&tool) {
            return Err(ReceiptError::InvalidOperation);
        }
        let digest = operation_digest(tool, arguments);
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(previous) = read_row(&tx, id)? {
            return Ok(
                if previous.tool_name == tool && previous.argument_digest == digest {
                    Admission::Same(previous)
                } else {
                    Admission::Conflict(previous)
                },
            );
        }
        if tool == "upgrade_agent" {
            let pending: Option<i64> = tx.query_row(
                "SELECT 1 FROM receipts WHERE tool_name='upgrade_agent' AND state!='completed' LIMIT 1",
                [], |r| r.get(0),
            ).optional()?;
            if pending.is_some() {
                return Ok(Admission::Full);
            }
        }
        cleanup_expired(&tx)?;
        let now = iso_now(&tx)?;
        tx.execute(
            "INSERT INTO receipts VALUES (?1,?2,?3,'admitted',?4,?4,NULL,NULL,1)",
            params![id, tool, digest, now],
        )?;
        tx.commit()?;
        if let Some(activity) = self.session_activity.as_mut() {
            activity.touch();
        }
        Ok(Admission::New(self.get(id)?.ok_or(ReceiptError::NotFound)?))
    }

    pub fn update(
        &mut self,
        id: &str,
        state: &str,
        summary: &str,
        session_id: Option<&str>,
        known_no_effect: bool,
    ) -> Result<Receipt, ReceiptError> {
        self.require_available()?;
        if !STATES.contains(&state) {
            return Err(ReceiptError::InvalidOperation);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_row(&tx, id)?.ok_or(ReceiptError::NotFound)?;
        let guarded = previous.tool_name == "upgrade_agent"
            || state == "unknown"
            || state == "admitted"
            || state == "running"
            || (state == "failed" && !known_no_effect);
        tx.execute(
            "UPDATE receipts SET state=?1, updated_at=?2, safe_result_summary=?3,
             session_id=COALESCE(?4,session_id), guarded=?5 WHERE operation_id=?6",
            params![
                state,
                iso_now(&tx)?,
                summary.chars().take(128).collect::<String>(),
                session_id,
                if guarded { 1 } else { 0 },
                id
            ],
        )?;
        tx.commit()?;
        if let Some(activity) = self.session_activity.as_mut() {
            if previous.tool_name == "start_process"
                && previous.state != state
                && matches!(state, "completed" | "failed" | "unknown")
            {
                activity.touch();
            }
            if state == "unknown" {
                activity.mark_unknown();
            }
        }
        self.get(id)?.ok_or(ReceiptError::NotFound)
    }
}

#[cfg(test)]
mod runtime_fault_tests {
    use super::*;

    fn temporary_store() -> (tempfile::TempDir, ReceiptStore) {
        let root = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        crate::seal_new_windows_private_directory(root.path()).unwrap();
        let store = ReceiptStore::open(&root.path().join("receipts")).unwrap();
        (root, store)
    }

    #[cfg(unix)]
    #[test]
    fn recovered_interrupted_receipt_never_proves_session_idle() {
        let (root, mut store) = temporary_store();
        store
            .admit("interrupted", "write_file", &serde_json::json!({}))
            .unwrap();
        drop(store);
        let mut store = ReceiptStore::open(&root.path().join("receipts")).unwrap();
        assert_eq!(store.get("interrupted").unwrap().unwrap().state, "unknown");
        store.enable_session_activity().unwrap();
        let attempt = crate::session_enrollment::SessionPhysicalAttempt {
            attempt_id: "11111111-1111-4111-8111-111111111111".into(),
            github_run_id: 1,
            github_run_attempt: 1,
            workflow_name: "ubuntu".into(),
        };
        let (idle, frame) = store
            .session_activity
            .as_mut()
            .unwrap()
            .snapshot(&attempt, true, false);
        assert!(!idle);
        assert_eq!(
            serde_json::from_str::<Value>(&frame).unwrap()["state"],
            "unknown"
        );
    }

    #[test]
    fn real_sqlite_readonly_and_full_latch_without_reopening() {
        let (_root, mut readonly) = temporary_store();
        readonly
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        let error = readonly
            .admit("blocked", "write_file", &serde_json::json!({}))
            .unwrap_err();
        assert_eq!(error.diagnostic(), "receipt_readonly");
        readonly.isolate(&error).unwrap();
        assert!(!readonly.available());
        assert!(matches!(
            readonly.admit("blocked-again", "write_file", &serde_json::json!({})),
            Err(ReceiptError::Unavailable)
        ));
        verify_exclusive(&readonly.connection).unwrap();

        let (_root, mut full) = temporary_store();
        let pages: i64 = full
            .connection
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap();
        let _: i64 = full
            .connection
            .query_row(&format!("PRAGMA max_page_count={pages}"), [], |r| r.get(0))
            .unwrap();
        let error = (0..2000)
            .find_map(|n| {
                full.admit(
                    &format!("full-{n:04}"),
                    "write_file",
                    &serde_json::json!({}),
                )
                .err()
            })
            .expect("page limit must produce an actual SQLite FULL error");
        assert_eq!(error.diagnostic(), "receipt_full");
        full.isolate(&error).unwrap();
        assert!(!full.available());
        verify_exclusive(&full.connection).unwrap();
    }

    #[test]
    fn deferred_constraint_commit_failure_preserves_guarded_running_record() {
        let (_root, mut store) = temporary_store();
        store.connection.execute_batch("PRAGMA foreign_keys=ON;
          CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY);
          CREATE TABLE fixture_child(parent INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED);
          CREATE TRIGGER fixture_commit AFTER UPDATE ON receipts WHEN NEW.state='completed'
          BEGIN INSERT INTO fixture_child VALUES (7); END;").unwrap();
        assert!(matches!(
            store
                .admit("commit-fault", "write_file", &serde_json::json!({}))
                .unwrap(),
            Admission::New(_)
        ));
        store
            .update(
                "commit-fault",
                "running",
                "before external effect",
                None,
                false,
            )
            .unwrap();
        let error = store
            .update("commit-fault", "completed", "effect done", None, false)
            .unwrap_err();
        assert_eq!(store.get("commit-fault").unwrap().unwrap().state, "running");
        store.isolate(&error).unwrap();
        assert!(!store.available());
        verify_exclusive(&store.connection).unwrap();
    }

    #[test]
    fn unsafe_or_competing_startup_does_not_degrade() {
        let (root, owner) = temporary_store();
        assert!(ReceiptStore::open_runtime(&owner.directory, |_| {}).is_err());
        drop(owner);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let directory = root.path().join("receipts");
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(matches!(
                ReceiptStore::open_runtime(&directory, |_| {}),
                Err(ReceiptError::UnsafePath)
            ));
        }
        #[cfg(windows)]
        drop(root);
    }
}
