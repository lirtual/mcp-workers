//! Native Node-compatible write_file core, not yet connected to a shipping Agent.
//! A verified WSS lease must be checked by the caller before invoking write_file.
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
    #[error("invalid write_file operation arguments")]
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

#[derive(Clone, Copy)]
enum EffectFailure {
    NoTargetEffect,
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

    /// Require the authenticated connection lease before admission and again
    /// after receipt persistence, immediately before any filesystem effect.
    /// The callback must reflect live revocation/Stop, not a snapshot.
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
        let admission = self.receipts.admit(id, "write_file", &args.normalized)?;
        match admission {
            Admission::Same(receipt) => {
                let state = match receipt.state.as_str() {
                    "completed" => "completed",
                    "failed" => "failed",
                    _ => "unknown", // admitted/running/unknown must never re-execute
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
                })
            }
            Admission::Full => {
                return Ok(WriteOutcome {
                    state: "unavailable",
                    receipt: None,
                })
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
        let result = effect(&args);
        let (state, summary, no_effect) = match result {
            Ok(()) => ("completed", "Operation completed.", false),
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
