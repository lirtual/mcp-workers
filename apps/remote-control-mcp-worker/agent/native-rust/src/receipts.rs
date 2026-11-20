//! SQLite receipt seam for the Node Agent's user_version=1 schema.
//! An admitted external effect may not be blindly replayed after restart.
//! Deliberately not wired to OS mutations until Gate 0 integration passes.
use crate::digest::operation_digest;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
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
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
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
    pub directory: PathBuf,
}

fn valid_id(id: &str) -> bool {
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

#[cfg(not(unix))]
fn private_path(_path: &Path, _is_dir: bool) -> Result<(), ReceiptError> {
    // ACL equivalence is a Gate 1 prerequisite. Never accept unchecked Windows state.
    Err(ReceiptError::UnsafePath)
}

fn private_directory(directory: &Path) -> Result<(), ReceiptError> {
    if !directory.exists() {
        fs::create_dir(directory)?;
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

impl ReceiptStore {
    /// Refuses nonprivate directories, unfamiliar versions and concurrent writers.
    pub fn open(directory: &Path) -> Result<Self, ReceiptError> {
        Self::open_with_historical(directory, None)
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
            directory: directory.to_owned(),
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<Receipt>, ReceiptError> {
        if !valid_id(id) {
            return Err(ReceiptError::InvalidOperation);
        }
        read_row(&self.connection, id)
    }

    pub fn admit(
        &mut self,
        id: &str,
        tool: &str,
        arguments: &Value,
    ) -> Result<Admission, ReceiptError> {
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
        let now = iso_now(&tx)?;
        tx.execute(
            "INSERT INTO receipts VALUES (?1,?2,?3,'admitted',?4,?4,NULL,NULL,1)",
            params![id, tool, digest, now],
        )?;
        tx.commit()?;
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
        self.get(id)?.ok_or(ReceiptError::NotFound)
    }
}
