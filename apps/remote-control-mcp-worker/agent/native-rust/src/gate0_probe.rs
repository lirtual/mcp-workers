//! Deliberately narrow, disposable Gate 0 tracer, not a supported RCA executor.
//! One hard-coded file under a private test root demonstrates durable admission
//! before a real effect. Replace with the full validated file/Shell module in Gate 1.
use crate::identity::valid_device_id;
use crate::receipts::{Admission, ReceiptError, ReceiptStore};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProbeError {
    #[error("invalid or unsupported probe frame")]
    InvalidFrame,
    #[error("untrusted test-only directory")]
    UnsafeRoot,
    #[error("receipt persistence unavailable: {0}")]
    Receipt(#[from] ReceiptError),
    #[error("probe state unavailable: {0}")]
    Io(#[from] std::io::Error),
}

pub struct Gate0Probe {
    receipts: ReceiptStore,
    target: PathBuf,
}

impl Gate0Probe {
    /// Accepts only a disposable, owner-private, *non-symlink* temporary root
    /// named rca-rust-probe-*; cannot open a normal Agent home/state path.
    pub fn new(root: &Path) -> Result<Self, ProbeError> {
        let meta = fs::symlink_metadata(root)?;
        if !meta.is_dir()
            || meta.file_type().is_symlink()
            || !root.is_absolute()
            || !root
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.starts_with("rca-rust-probe-"))
        {
            return Err(ProbeError::UnsafeRoot);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if meta.uid() != unsafe { libc::geteuid() } || meta.permissions().mode() & 0o077 != 0 {
                return Err(ProbeError::UnsafeRoot);
            }
        }
        #[cfg(not(unix))]
        {
            return Err(ProbeError::UnsafeRoot);
        }
        let canonical = fs::canonicalize(root)?;
        if canonical != root {
            return Err(ProbeError::UnsafeRoot);
        }
        Ok(Self {
            receipts: ReceiptStore::open(&root.join("receipts"))?,
            target: root.join("probe.txt"),
        })
    }

    /// One existing WSS operation frame and its bounded response. Invalid
    /// frames are refused so the caller can terminate the signed connection.
    pub fn handle(&mut self, frame: &str) -> Result<String, ProbeError> {
        if frame.len() > 65_536 {
            return Err(ProbeError::InvalidFrame);
        }
        let req: Value = serde_json::from_str(frame).map_err(|_| ProbeError::InvalidFrame)?;
        let object = req.as_object().ok_or(ProbeError::InvalidFrame)?;
        let request_id = req["request_id"].as_str().ok_or(ProbeError::InvalidFrame)?;
        if !valid_device_id(request_id) {
            return Err(ProbeError::InvalidFrame);
        }
        if req["kind"] == "read" && object.len() == 4 && req["tool"] == "read_file" {
            let args = req["arguments"]
                .as_object()
                .ok_or(ProbeError::InvalidFrame)?;
            if args.len() != 1 || args.get("path").and_then(Value::as_str) != self.target.to_str() {
                return Err(ProbeError::InvalidFrame);
            }
            let read = (|| -> std::io::Result<String> {
                let mut open = OpenOptions::new();
                open.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    open.custom_flags(libc::O_NOFOLLOW);
                }
                let file = open.open(&self.target)?;
                if !file.metadata()?.is_file() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "not a file",
                    ));
                }
                let mut bytes = Vec::new();
                file.take(4_097).read_to_end(&mut bytes)?;
                if bytes.len() > 4_096 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "too large",
                    ));
                }
                String::from_utf8(bytes)
                    .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "not UTF-8"))
            })();
            return Ok(match read {
                Ok(text) => json!({"kind":"read_result","request_id":request_id,"status":"completed","text":text}).to_string(),
                Err(_) => json!({"kind":"read_result","request_id":request_id,"status":"failed"}).to_string(),
            });
        }
        if object.len() != 5 || req["kind"] != "operation" {
            return Err(ProbeError::InvalidFrame);
        }
        let id = req["operation_id"]
            .as_str()
            .ok_or(ProbeError::InvalidFrame)?;
        let tool = req["tool"].as_str().ok_or(ProbeError::InvalidFrame)?;
        let args = req["arguments"]
            .as_object()
            .ok_or(ProbeError::InvalidFrame)?;
        let result = if tool == "get_operation_status" {
            if args.len() != 1 || args.get("operation_id").and_then(Value::as_str) != Some(id) {
                return Err(ProbeError::InvalidFrame);
            }
            match self.receipts.get(id)? {
                Some(receipt) => {
                    json!({"operation_id":id,"status":receipt.state,"receipt":receipt})
                }
                None => json!({"operation_id":id,"status":"not_found"}),
            }
        } else if tool == "write_file" {
            if args.len() != 2 || args.get("path").and_then(Value::as_str) != self.target.to_str() {
                return Err(ProbeError::InvalidFrame);
            }
            let text = args
                .get("content")
                .and_then(Value::as_str)
                .ok_or(ProbeError::InvalidFrame)?;
            if text.len() > 4_096 {
                return Err(ProbeError::InvalidFrame);
            }
            match self.receipts.admit(id, tool, &req["arguments"])? {
                Admission::Same(receipt) => json!({"operation_id":id,"status":receipt.state}),
                Admission::Conflict(_) => json!({"operation_id":id,"status":"conflict"}),
                Admission::Full => json!({"operation_id":id,"status":"unavailable"}),
                Admission::New(_) => {
                    // Only a fresh file; never overwrite arbitrary user data.
                    // If effect/commit status is uncertain, preserve replay guard.
                    let write = (|| -> std::io::Result<()> {
                        let mut options = OpenOptions::new();
                        options.write(true).create_new(true);
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::OpenOptionsExt;
                            options.mode(0o600);
                        }
                        let mut file = options.open(&self.target)?;
                        file.write_all(text.as_bytes())?;
                        file.sync_all()?;
                        // Persist the new directory entry before committing the
                        // completed receipt, not just its content and inode.
                        let parent = self.target.parent().ok_or_else(|| {
                            std::io::Error::new(std::io::ErrorKind::InvalidInput, "probe root")
                        })?;
                        fs::File::open(parent)?.sync_all()
                    })();
                    let state = if write.is_ok() {
                        "completed"
                    } else {
                        "unknown"
                    };
                    self.receipts.update(
                        id,
                        state,
                        if write.is_ok() {
                            "Disposable probe file written."
                        } else {
                            "Effect cannot be established; operator reconciliation required."
                        },
                        None,
                        false,
                    )?;
                    json!({"operation_id":id,"status":state})
                }
            }
        } else {
            return Err(ProbeError::InvalidFrame);
        };
        Ok(json!({"kind":"operation_result","request_id":request_id,"result":result}).to_string())
    }
}
