//! Node-compatible receipt-guarded file mutations, not connected to a shipping Agent.
//! A verified WSS lease must be checked before any operation admission or file effect.
//! Receipt admission precedes effects, and an uncertain effect is never retried.
use crate::native_read::permitted_path;
use crate::receipts::{Admission, Receipt, ReceiptError, ReceiptStore};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "linux")]
use std::{fs::File, io};
use thiserror::Error;

const MAX_CONTENT_BYTES: usize = 49_152;

#[derive(Debug, Error)]
pub enum NativeWriteError {
    #[error("invalid native file operation arguments")]
    InvalidInput,
    #[error("operation lease was revoked before any target effect")]
    LeaseRevoked,
    #[error(transparent)]
    Receipt(#[from] ReceiptError),
}

#[derive(Debug)]
pub struct WriteOutcome {
    pub state: &'static str,
    pub receipt: Option<Receipt>,
}

pub struct NativeWriteExecutor {
    receipts: ReceiptStore,
}

struct WriteArgs {
    target: PathBuf,
    content: String,
    mode: WriteMode,
    normalized: Value,
}

#[derive(Clone, Copy)]
enum WriteMode {
    Rewrite,
    Append,
}

fn normalized_path(raw: &str) -> Option<PathBuf> {
    let supplied = Path::new(raw);
    let absolute = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(supplied)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized.is_absolute().then_some(normalized)
}

pub(crate) fn valid_write_args(value: &Value) -> bool {
    parse_write_args(value).is_ok()
}

fn parse_write_args(value: &Value) -> Result<WriteArgs, NativeWriteError> {
    let object = value.as_object().ok_or(NativeWriteError::InvalidInput)?;
    if object.len() != 3
        || !object.contains_key("path")
        || !object.contains_key("content")
        || !object.contains_key("mode")
    {
        return Err(NativeWriteError::InvalidInput);
    }
    let raw = object["path"]
        .as_str()
        .ok_or(NativeWriteError::InvalidInput)?;
    if !permitted_path(raw) {
        return Err(NativeWriteError::InvalidInput);
    }
    let target = normalized_path(raw).ok_or(NativeWriteError::InvalidInput)?;
    let content = object["content"]
        .as_str()
        .ok_or(NativeWriteError::InvalidInput)?;
    if content.len() > MAX_CONTENT_BYTES || content.contains('\0') {
        return Err(NativeWriteError::InvalidInput);
    }
    let mode = match object["mode"].as_str() {
        Some("rewrite") => WriteMode::Rewrite,
        Some("append") => WriteMode::Append,
        _ => return Err(NativeWriteError::InvalidInput),
    };
    let normalized = json!({
        "path": target.to_str().ok_or(NativeWriteError::InvalidInput)?,
        "content": content,
        "mode": object["mode"],
    });
    Ok(WriteArgs {
        target,
        content: content.to_owned(),
        mode,
        normalized,
    })
}

struct PathArgs {
    target: PathBuf,
    normalized: Value,
}

/// Shared Node path-only argument contract for create_directory/delete_file.
pub(crate) fn valid_path_args(value: &Value) -> bool {
    parse_path_args(value).is_ok()
}

fn parse_path_args(value: &Value) -> Result<PathArgs, NativeWriteError> {
    let object = value.as_object().ok_or(NativeWriteError::InvalidInput)?;
    if object.len() != 1 {
        return Err(NativeWriteError::InvalidInput);
    }
    let raw = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or(NativeWriteError::InvalidInput)?;
    if !permitted_path(raw) {
        return Err(NativeWriteError::InvalidInput);
    }
    let target = normalized_path(raw).ok_or(NativeWriteError::InvalidInput)?;
    let normalized = json!({
        "path": target.to_str().ok_or(NativeWriteError::InvalidInput)?
    });
    Ok(PathArgs { target, normalized })
}

struct EditArgs {
    target: PathBuf,
    old_string: String,
    new_string: String,
    expected_replacements: usize,
    normalized: Value,
}

/// Node's edit_block admits exact UTF-8 replacements with an optional
/// expected_replacements count of one, never an arbitrary edit script.
pub(crate) fn valid_edit_args(value: &Value) -> bool {
    parse_edit_args(value).is_ok()
}

fn parse_edit_args(value: &Value) -> Result<EditArgs, NativeWriteError> {
    let object = value.as_object().ok_or(NativeWriteError::InvalidInput)?;
    if object.len() < 3
        || object.len() > 4
        || object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "file_path" | "old_string" | "new_string" | "expected_replacements"
            )
        })
    {
        return Err(NativeWriteError::InvalidInput);
    }
    let raw = object
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or(NativeWriteError::InvalidInput)?;
    if !permitted_path(raw) {
        return Err(NativeWriteError::InvalidInput);
    }
    let target = normalized_path(raw).ok_or(NativeWriteError::InvalidInput)?;
    let old_string = object
        .get("old_string")
        .and_then(Value::as_str)
        .ok_or(NativeWriteError::InvalidInput)?;
    let new_string = object
        .get("new_string")
        .and_then(Value::as_str)
        .ok_or(NativeWriteError::InvalidInput)?;
    if old_string.is_empty()
        || old_string.len() > MAX_CONTENT_BYTES
        || new_string.len() > MAX_CONTENT_BYTES
        || old_string.contains('\0')
        || new_string.contains('\0')
    {
        return Err(NativeWriteError::InvalidInput);
    }
    let expected = match object.get("expected_replacements") {
        None => 1,
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| {
                number.as_f64().and_then(|value| {
                    (value.is_finite() && value.fract() == 0.0 && (1.0..=1000.0).contains(&value))
                        .then_some(value as u64)
                })
            })
            .ok_or(NativeWriteError::InvalidInput)?,
        _ => return Err(NativeWriteError::InvalidInput),
    };
    if !(1..=1000).contains(&expected) {
        return Err(NativeWriteError::InvalidInput);
    }
    let normalized = json!({
        "file_path": target.to_str().ok_or(NativeWriteError::InvalidInput)?,
        "old_string": old_string,
        "new_string": new_string,
        "expected_replacements": expected,
    });
    Ok(EditArgs {
        target,
        old_string: old_string.to_owned(),
        new_string: new_string.to_owned(),
        expected_replacements: expected as usize,
        normalized,
    })
}

fn unchanged_identity(original: &fs::Metadata, current: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if original.dev() != current.dev()
            || original.ino() != current.ino()
            || original.ctime() != current.ctime()
            || original.ctime_nsec() != current.ctime_nsec()
        {
            return false;
        }
    }
    original.is_file()
        && current.is_file()
        && original.len() == current.len()
        && original.modified().ok() == current.modified().ok()
}

/// Each read uses one file descriptor, checking for changes across the read.
/// This is the same best-effort precommit validation as Node, not an external
/// writer CAS or a guarantee against races after the final validation.
fn read_stable_file(target: &Path) -> Result<(Vec<u8>, fs::Metadata), EffectFailure> {
    use std::io::Read;
    let mut file = fs::File::open(target).map_err(|_| EffectFailure::NoTargetEffect)?;
    let before = file.metadata().map_err(|_| EffectFailure::NoTargetEffect)?;
    if !before.is_file() {
        return Err(EffectFailure::NoTargetEffect);
    }
    let mut content = Vec::new();
    file.read_to_end(&mut content)
        .map_err(|_| EffectFailure::NoTargetEffect)?;
    let after = file.metadata().map_err(|_| EffectFailure::NoTargetEffect)?;
    if !unchanged_identity(&before, &after) {
        return Err(EffectFailure::NoTargetEffect);
    }
    Ok((content, before))
}

fn edit_effect(args: &EditArgs) -> Result<(), EffectFailure> {
    let (bytes, identity) = read_stable_file(&args.target)?;
    let original = std::str::from_utf8(&bytes).map_err(|_| EffectFailure::InvalidUtf8)?;
    if original.matches(&args.old_string).count() != args.expected_replacements {
        return Err(EffectFailure::ReplacementCountMismatch);
    }
    let replacement = original.replace(&args.old_string, &args.new_string);
    let (current_bytes, current_identity) = read_stable_file(&args.target)?;
    if !unchanged_identity(&identity, &current_identity) || current_bytes != bytes {
        return Err(EffectFailure::NoTargetEffect);
    }
    // In-place writing preserves symlink/hardlink/open-handle inode semantics.
    // After a successful truncate, any error is Unknown, never safe to replay.
    let mut handle = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&args.target)
        .map_err(|_| EffectFailure::NoTargetEffect)?;
    handle
        .write_all(replacement.as_bytes())
        .map_err(|_| EffectFailure::Unknown)?;
    handle.sync_all().map_err(|_| EffectFailure::Unknown)
}

struct MoveArgs {
    source: PathBuf,
    destination: PathBuf,
    normalized: Value,
}

/// The Worker and Node Agent admit exactly a source/destination pair.
pub(crate) fn valid_move_args(value: &Value) -> bool {
    parse_move_args(value).is_ok()
}

fn parse_move_args(value: &Value) -> Result<MoveArgs, NativeWriteError> {
    let object = value.as_object().ok_or(NativeWriteError::InvalidInput)?;
    if object.len() != 2 {
        return Err(NativeWriteError::InvalidInput);
    }
    let source_raw = object
        .get("source")
        .and_then(Value::as_str)
        .ok_or(NativeWriteError::InvalidInput)?;
    let dest_raw = object
        .get("destination")
        .and_then(Value::as_str)
        .ok_or(NativeWriteError::InvalidInput)?;
    if source_raw == dest_raw || !permitted_path(source_raw) || !permitted_path(dest_raw) {
        return Err(NativeWriteError::InvalidInput);
    }
    let source = normalized_path(source_raw).ok_or(NativeWriteError::InvalidInput)?;
    let destination = normalized_path(dest_raw).ok_or(NativeWriteError::InvalidInput)?;
    let normalized = json!({
        "source": source.to_str().ok_or(NativeWriteError::InvalidInput)?,
        "destination": destination.to_str().ok_or(NativeWriteError::InvalidInput)?
    });
    Ok(MoveArgs {
        source,
        destination,
        normalized,
    })
}

/// Match Node's no-overwrite link+unlink move, including rollback of a
/// newly made hardlink if source unlink fails; never copy across volumes.
fn move_effect(args: &MoveArgs) -> Result<(), EffectFailure> {
    if args.source == args.destination {
        return Err(EffectFailure::SamePath);
    }
    let meta = fs::symlink_metadata(&args.source).map_err(classify_path_error)?;
    if !meta.file_type().is_file() {
        return Err(EffectFailure::SourceNotRegular);
    }
    fs::hard_link(&args.source, &args.destination).map_err(classify_path_error)?;
    if fs::remove_file(&args.source).is_ok() {
        return Ok(());
    }
    // The source did not unlink. A successful rollback restores the
    // original visible names; an unconfirmed rollback must remain Unknown.
    if fs::remove_file(&args.destination).is_ok() {
        Err(EffectFailure::NoTargetEffect)
    } else {
        Err(EffectFailure::Unknown)
    }
}

#[derive(Clone, Copy)]
enum PathMutation {
    CreateDirectory,
    DeleteFile,
}

impl PathMutation {
    fn tool_name(self) -> &'static str {
        match self {
            Self::CreateDirectory => "create_directory",
            Self::DeleteFile => "delete_file",
        }
    }
}

fn path_effect(mutation: PathMutation, target: &Path) -> Result<(), EffectFailure> {
    let result = match mutation {
        PathMutation::CreateDirectory => fs::create_dir(target),
        PathMutation::DeleteFile => {
            let meta = fs::symlink_metadata(target).map_err(classify_path_error)?;
            if !meta.file_type().is_file() {
                return Err(EffectFailure::NotRegular);
            }
            fs::remove_file(target)
        }
    };
    result.map_err(classify_path_error)
}

fn classify_path_error(error: std::io::Error) -> EffectFailure {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::PermissionDenied
        | ErrorKind::NotFound
        | ErrorKind::AlreadyExists
        | ErrorKind::IsADirectory
        | ErrorKind::NotADirectory
        | ErrorKind::InvalidInput
        | ErrorKind::Unsupported
        | ErrorKind::CrossesDevices => EffectFailure::NoTargetEffect,
        _ => EffectFailure::Unknown,
    }
}

#[derive(Clone, Copy)]
enum EffectFailure {
    NoTargetEffect,
    NotRegular,
    SourceNotRegular,
    SamePath,
    InvalidUtf8,
    ReplacementCountMismatch,
    Unknown,
}

fn legacy_write(args: &WriteArgs) -> Result<(), EffectFailure> {
    let mut open = OpenOptions::new();
    open.write(true).create(true);
    match args.mode {
        WriteMode::Rewrite => {
            open.truncate(true);
        }
        WriteMode::Append => {
            open.append(true);
        }
    }
    // If open() fails, there is no opened target and no write has begun.
    // Once it succeeds, even an unsuccessful write/sync may have modified bytes.
    let mut file = open
        .open(&args.target)
        .map_err(|_| EffectFailure::NoTargetEffect)?;
    file.write_all(args.content.as_bytes())
        .map_err(|_| EffectFailure::Unknown)?;
    file.sync_all().map_err(|_| EffectFailure::Unknown)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn private_ext_parent(target: &Path) -> Option<(PathBuf, u32)> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if unsafe { libc::getuid() } != unsafe { libc::geteuid() }
        || unsafe { libc::getgid() } != unsafe { libc::getegid() }
    {
        return None;
    }
    let parent = target.parent()?.to_path_buf();
    if target.file_name()?.as_encoded_bytes().len() > 200 {
        return None;
    }
    let metadata = fs::symlink_metadata(&parent).ok()?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o3077 != 0
        || fs::canonicalize(&parent).ok()? != parent
    {
        return None;
    }
    // Stage only on Node's previously-verified Linux ext-filesystem subset.
    use std::os::unix::ffi::OsStrExt;
    let parent_c = std::ffi::CString::new(parent.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(parent_c.as_ptr(), &mut stat) } != 0 || stat.f_type != 0xef53 {
        return None;
    }
    match fs::symlink_metadata(target) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        _ => return None,
    }
    // Reading the effective umask is side-effect-free; never temporarily
    // change the process-wide umask in a multi-threaded Agent.
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let raw = status
        .lines()
        .find_map(|line| line.strip_prefix("Umask:\t"))?
        .trim();
    let mask = u32::from_str_radix(raw, 8).ok()?;
    Some((parent, 0o666 & !mask))
}

#[cfg(not(target_os = "linux"))]
fn private_ext_parent(_target: &Path) -> Option<(PathBuf, u32)> {
    None
}

#[cfg(target_os = "linux")]
fn staged_new_file(
    target: &Path,
    content: &str,
    parent: &Path,
    mode: u32,
) -> Result<(), EffectFailure> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let mut randomness = [0_u8; 16];
    getrandom::fill(&mut randomness).map_err(|_| EffectFailure::NoTargetEffect)?;
    let suffix: String = randomness.iter().map(|b| format!("{b:02x}")).collect();
    let name = target
        .file_name()
        .ok_or(EffectFailure::NoTargetEffect)?
        .to_string_lossy();
    let temp = parent.join(format!(".{name}.rca-{suffix}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let mut file = options
        .open(&temp)
        .map_err(|_| EffectFailure::NoTargetEffect)?;
    let owned = file.metadata().ok().map(|m| (m.dev(), m.ino()));
    let result = (|| {
        file.write_all(content.as_bytes())
            .map_err(|_| EffectFailure::NoTargetEffect)?;
        file.sync_all().map_err(|_| EffectFailure::NoTargetEffect)?;
        file.set_permissions(fs::Permissions::from_mode(mode))
            .map_err(|_| EffectFailure::NoTargetEffect)?;
        file.sync_all().map_err(|_| EffectFailure::NoTargetEffect)?;
        drop(file);
        if fs::symlink_metadata(target).is_ok() {
            return Err(EffectFailure::NoTargetEffect);
        }
        // Only EEXIST proves that hard_link had no effect. All other failures
        // after entering the link syscall conservatively require reconciliation.
        match fs::hard_link(&temp, target) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(EffectFailure::NoTargetEffect)
            }
            Err(_) => return Err(EffectFailure::Unknown),
        }
        File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| EffectFailure::Unknown)?;
        Ok(())
    })();
    if let Some((dev, ino)) = owned {
        if fs::symlink_metadata(&temp)
            .ok()
            .is_some_and(|m| m.dev() == dev && m.ino() == ino)
        {
            // Cleanup failure is an operational diagnostic; it cannot change
            // an established target effect into a different receipt state.
            let _ = fs::remove_file(&temp);
        }
    }
    result
}

fn effect(args: &WriteArgs) -> Result<(), EffectFailure> {
    if matches!(args.mode, WriteMode::Rewrite) {
        if let Some((parent, mode)) = private_ext_parent(&args.target) {
            #[cfg(target_os = "linux")]
            return staged_new_file(&args.target, &args.content, &parent, mode);
            #[cfg(not(target_os = "linux"))]
            {
                let _ = (parent, mode);
            }
        }
    }
    legacy_write(args)
}

impl NativeWriteExecutor {
    /// Requires an exclusive, private receipt directory and stopped old Agent.
    /// This library intentionally does not connect to WSS or grant itself.
    pub fn open(receipt_directory: &Path) -> Result<Self, NativeWriteError> {
        Ok(Self {
            receipts: ReceiptStore::open(receipt_directory)?,
        })
    }

    pub fn get_receipt(&self, id: &str) -> Result<Option<Receipt>, NativeWriteError> {
        Ok(self.receipts.get(id)?)
    }

    /// The process adapter shares this exact SQLite owner with file writes.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub(crate) fn receipt_store_mut(&mut self) -> &mut ReceiptStore {
        &mut self.receipts
    }

    /// A live authenticated lease is checked before receipt admission and
    /// again after the running state is persisted, immediately before effect.
    pub fn write_file_with_lease(
        &mut self,
        id: &str,
        arguments: &Value,
        mut lease_active: impl FnMut() -> bool,
    ) -> Result<WriteOutcome, NativeWriteError> {
        if !lease_active() {
            return Err(NativeWriteError::LeaseRevoked);
        }
        let args = parse_write_args(arguments)?;
        self.mutate_with_receipt(id, "write_file", &args.normalized, lease_active, || {
            effect(&args)
        })
    }

    pub fn create_directory_with_lease(
        &mut self,
        id: &str,
        arguments: &Value,
        lease_active: impl FnMut() -> bool,
    ) -> Result<WriteOutcome, NativeWriteError> {
        self.path_mutation_with_lease(id, PathMutation::CreateDirectory, arguments, lease_active)
    }

    pub fn delete_file_with_lease(
        &mut self,
        id: &str,
        arguments: &Value,
        lease_active: impl FnMut() -> bool,
    ) -> Result<WriteOutcome, NativeWriteError> {
        self.path_mutation_with_lease(id, PathMutation::DeleteFile, arguments, lease_active)
    }

    pub fn edit_block_with_lease(
        &mut self,
        id: &str,
        arguments: &Value,
        mut lease_active: impl FnMut() -> bool,
    ) -> Result<WriteOutcome, NativeWriteError> {
        if !lease_active() {
            return Err(NativeWriteError::LeaseRevoked);
        }
        let args = parse_edit_args(arguments)?;
        self.mutate_with_receipt(id, "edit_block", &args.normalized, lease_active, || {
            edit_effect(&args)
        })
    }

    pub fn move_file_with_lease(
        &mut self,
        id: &str,
        arguments: &Value,
        mut lease_active: impl FnMut() -> bool,
    ) -> Result<WriteOutcome, NativeWriteError> {
        if !lease_active() {
            return Err(NativeWriteError::LeaseRevoked);
        }
        let args = parse_move_args(arguments)?;
        self.mutate_with_receipt(id, "move_file", &args.normalized, lease_active, || {
            move_effect(&args)
        })
    }

    fn path_mutation_with_lease(
        &mut self,
        id: &str,
        mutation: PathMutation,
        arguments: &Value,
        mut lease_active: impl FnMut() -> bool,
    ) -> Result<WriteOutcome, NativeWriteError> {
        if !lease_active() {
            return Err(NativeWriteError::LeaseRevoked);
        }
        let args = parse_path_args(arguments)?;
        self.mutate_with_receipt(
            id,
            mutation.tool_name(),
            &args.normalized,
            lease_active,
            || path_effect(mutation, &args.target),
        )
    }

    /// One authoritative receipt/lease state machine for every file mutation.
    /// Admitted/running/unknown receipts must never re-enter a target effect.
    fn mutate_with_receipt(
        &mut self,
        id: &str,
        tool: &str,
        normalized: &Value,
        mut lease_active: impl FnMut() -> bool,
        perform: impl FnOnce() -> Result<(), EffectFailure>,
    ) -> Result<WriteOutcome, NativeWriteError> {
        let admission = self.receipts.admit(id, tool, normalized)?;
        match admission {
            Admission::Same(receipt) => {
                let state = match receipt.state.as_str() {
                    "completed" => "completed",
                    "failed" => "failed",
                    _ => "unknown",
                };
                return Ok(WriteOutcome {
                    state,
                    receipt: Some(receipt),
                });
            }
            Admission::Conflict(receipt) => {
                return Ok(WriteOutcome {
                    state: "conflict",
                    receipt: Some(receipt),
                });
            }
            Admission::Full => {
                return Ok(WriteOutcome {
                    state: "unavailable",
                    receipt: None,
                });
            }
            Admission::New(_) => {}
        }
        self.receipts
            .update(id, "running", "Operation is in progress.", None, false)?;
        if !lease_active() {
            let receipt = self.receipts.update(
                id,
                "failed",
                "Lease revoked before any effect.",
                None,
                true,
            )?;
            return Ok(WriteOutcome {
                state: "failed",
                receipt: Some(receipt),
            });
        }
        let (state, summary, no_effect) = match perform() {
            Ok(()) => ("completed", "Operation completed.", false),
            Err(EffectFailure::NotRegular) => ("failed", "The target is not a regular file.", true),
            Err(EffectFailure::SourceNotRegular) => {
                ("failed", "The source is not a regular file.", true)
            }
            Err(EffectFailure::SamePath) => ("failed", "Source and destination must differ.", true),
            Err(EffectFailure::InvalidUtf8) => {
                ("failed", "The file is not valid UTF-8 text.", true)
            }
            Err(EffectFailure::ReplacementCountMismatch) => (
                "failed",
                "Expected text replacement count did not match.",
                true,
            ),
            Err(EffectFailure::NoTargetEffect) => ("failed", "Operation did not complete.", true),
            Err(EffectFailure::Unknown) => {
                ("unknown", "Operation outcome cannot be established.", false)
            }
        };
        let receipt = self.receipts.update(id, state, summary, None, no_effect)?;
        Ok(WriteOutcome {
            state,
            receipt: Some(receipt),
        })
    }
}
