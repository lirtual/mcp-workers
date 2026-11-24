//! Linux Standard candidate's owner-local upgrade consent socket.
//! Wire-compatible with the existing Node installer: never accepts remote commands.
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpgradeCommand {
    Freeze,
    VerifyFrozen,
    Release,
    IdleStatus,
    IdleFreeze,
}

pub struct UpgradeRequest {
    pub command: UpgradeCommand,
    pub reply: SyncSender<String>,
}

pub fn verify_upgrade_directory(key: &Path) -> io::Result<()> {
    let parent = key
        .parent()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "identity parent missing"))?;
    private_directory(parent)
}

fn private_directory(parent: &Path) -> io::Result<()> {
    let info = fs::symlink_metadata(parent)?;
    if !info.is_dir()
        || info.file_type().is_symlink()
        || info.uid() != unsafe { libc::geteuid() }
        || info.permissions().mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "unsafe owner-local upgrade directory",
        ));
    }
    Ok(())
}

fn clear_stale_owned(socket: &Path) -> io::Result<()> {
    let info = match fs::symlink_metadata(socket) {
        Ok(info) => info,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !info.file_type().is_socket() || info.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "unsafe owner-local upgrade socket",
        ));
    }
    match UnixStream::connect(socket) {
        Err(error) if error.kind() == ErrorKind::ConnectionRefused => fs::remove_file(socket),
        _ => Err(io::Error::new(
            ErrorKind::AddrInUse,
            "live or unavailable owner-local upgrade socket",
        )),
    }
}

fn handle_connection(mut stream: UnixStream, sender: &SyncSender<UpgradeRequest>) {
    if stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .is_err()
    {
        return;
    }
    let mut request = [0u8; 33];
    let mut used = 0;
    let command = loop {
        let received = match stream.read(&mut request[used..]) {
            Ok(0) | Err(_) => return,
            Ok(size) => size,
        };
        used += received;
        if used > 32 {
            return;
        }
        if request[..used].contains(&b'\n') {
            break match &request[..used] {
                b"freeze\n" => UpgradeCommand::Freeze,
                b"verify-frozen\n" => UpgradeCommand::VerifyFrozen,
                b"release\n" => UpgradeCommand::Release,
                b"idle-status\n" => UpgradeCommand::IdleStatus,
                b"idle-freeze\n" => UpgradeCommand::IdleFreeze,
                _ => return,
            };
        }
    };
    let (reply, response) = sync_channel(1);
    if sender.try_send(UpgradeRequest { command, reply }).is_err() {
        return;
    }
    if let Ok(response) = response.recv_timeout(Duration::from_secs(2)) {
        let _ = stream.write_all(response.as_bytes());
    }
}

/// A single owner-private IPC endpoint per Node-compatible identity directory.
/// It has no network listener and shares admission decisions with the executor.
pub struct UpgradeServer {
    path: PathBuf,
    inode: (u64, u64),
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl UpgradeServer {
    pub fn bind(key: &Path, sender: SyncSender<UpgradeRequest>) -> io::Result<Self> {
        let parent = key
            .parent()
            .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "identity parent missing"))?;
        private_directory(parent)?;
        let socket = parent.join("upgrade.sock");
        clear_stale_owned(&socket)?;
        let listener = UnixListener::bind(&socket)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        let info = fs::symlink_metadata(&socket)?;
        let inode = (info.dev(), info.ino());
        listener.set_nonblocking(true)?;
        let stopping = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stopping);
        let worker = thread::Builder::new()
            .name("rca-local-upgrade".to_owned())
            .spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => handle_connection(stream, &sender),
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(25));
                        }
                        Err(_) => break,
                    }
                }
            })?;
        Ok(Self {
            path: socket,
            inode,
            stopping,
            worker: Some(worker),
        })
    }
}

impl Drop for UpgradeServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if let Ok(info) = fs::symlink_metadata(&self.path) {
            if info.file_type().is_socket()
                && info.uid() == unsafe { libc::geteuid() }
                && (info.dev(), info.ino()) == self.inode
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}
