//! Keep ordinary file opens/effects away from the active private receipt tree.
//! In POSIX a close of *any* fd for a SQLite-locked inode in this process can
//! release the process's locks. Metadata checks do not open data descriptors.
//! This is an internal-file boundary, not a sandbox against the local account:
//! a privileged owner can still deliberately alter its own files via Shell.
use crate::receipts::ReceiptError;
use std::fs;
use std::path::{Path, PathBuf};

type Identity = (u64, u64);

#[cfg(unix)]
fn identity(path: &Path) -> std::io::Result<Identity> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(path)?;
    Ok((meta.dev(), meta.ino()))
}

#[cfg(windows)]
fn identity(path: &Path) -> std::io::Result<Identity> {
    crate::windows_private::file_identity(path)
}

#[cfg(not(any(unix, windows)))]
fn identity(_path: &Path) -> std::io::Result<Identity> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "file identity",
    ))
}

#[derive(Clone)]
pub(crate) struct ReceiptBoundary {
    root: PathBuf,
    root_id: Identity,
    db_id: Identity,
}

impl ReceiptBoundary {
    pub(crate) fn new(directory: &Path) -> Result<Self, ReceiptError> {
        let root = fs::canonicalize(directory)?;
        let root_id = identity(&root)?;
        let db_id = identity(&root.join("operation-receipts.sqlite"))?;
        Ok(Self {
            root,
            root_id,
            db_id,
        })
    }

    // Resolve existing symlinks, aliases and the closest existing parent of
    // a new target. A dangling or unresolvable existing link is not safe to
    // open with create/truncate; do not assume it refers to an ordinary file.
    pub(crate) fn blocks(&self, path: &Path) -> bool {
        let absolute = if path.is_absolute() {
            path.to_owned()
        } else {
            match std::env::current_dir() {
                Ok(cwd) => cwd.join(path),
                Err(_) => return true,
            }
        };
        let mut candidate = absolute.as_path();
        let resolved = loop {
            match fs::canonicalize(candidate) {
                Ok(path) => break path,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if fs::symlink_metadata(candidate).is_ok() {
                        return true;
                    }
                    match candidate.parent() {
                        Some(parent) => candidate = parent,
                        None => return true,
                    }
                }
                Err(_) => return true,
            }
        };
        if resolved.starts_with(&self.root) {
            return true;
        }
        let id = match identity(&resolved) {
            Ok(id) => id,
            Err(_) => return true,
        };
        if id == self.root_id || id == self.db_id {
            return true;
        }
        // A bind/junction alias of the receipt directory also protects new
        // children. Sidecars may exist only during a transaction.
        if resolved
            .parent()
            .is_some_and(|parent| identity(parent).ok() == Some(self.root_id))
        {
            return true;
        }
        for name in [
            "operation-receipts.sqlite-journal",
            "operation-receipts.sqlite-wal",
            "operation-receipts.sqlite-shm",
            "operation-receipts.json",
            "operation-receipts.pre-sqlite.json",
        ] {
            match identity(&self.root.join(name)) {
                Ok(protected) if protected == id => return true,
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return true,
            }
        }
        false
    }
}
