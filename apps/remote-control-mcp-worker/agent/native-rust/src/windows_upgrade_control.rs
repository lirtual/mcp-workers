//! Owner-local Windows named-pipe upgrade control, wire-compatible with Node and PowerShell.
#![cfg(windows)]

use crate::windows_private;
use sha2::{Digest, Sha256};
use std::io::{self, ErrorKind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING,
    GENERIC_ALL, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::{
    AddAccessAllowedAce, GetLengthSid, InitializeAcl, InitializeSecurityDescriptor,
    SetSecurityDescriptorDacl, ACL, ACL_REVISION, SECURITY_ATTRIBUTES,
};
use windows_sys::Win32::Storage::FileSystem::{
    ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, SetNamedPipeHandleState, PIPE_NOWAIT,
    PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
};
use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpgradeCommand {
    Freeze,
    VerifyFrozen,
    Release,
}
pub struct UpgradeRequest {
    pub command: UpgradeCommand,
    pub reply: SyncSender<&'static str>,
}

fn pipe_path(key: &Path) -> Result<Vec<u16>, io::Error> {
    let normalized = key.to_string_lossy().replace('/', "\\").to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    let name = format!(
        r"\\.\pipe\rca-upgrade-{}",
        digest[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    Ok(name.encode_utf16().chain(Some(0)).collect())
}

fn create_owner_pipe(name: &[u16]) -> io::Result<*mut core::ffi::c_void> {
    let sid_storage = windows_private::current_user_sid().map_err(|_| {
        io::Error::new(ErrorKind::PermissionDenied, "current owner SID unavailable")
    })?;
    let sid = unsafe {
        (*(sid_storage
            .as_ptr()
            .cast::<windows_sys::Win32::Security::TOKEN_USER>()))
        .User
        .Sid
    };
    let sid_len = unsafe { GetLengthSid(sid) };
    if sid.is_null() || sid_len == 0 || sid_len > 1024 {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "invalid owner SID",
        ));
    }
    let acl_bytes = std::mem::size_of::<ACL>()
        + std::mem::size_of::<windows_sys::Win32::Security::ACCESS_ALLOWED_ACE>()
        - std::mem::size_of::<u32>()
        + sid_len as usize;
    let acl_words = acl_bytes.div_ceil(std::mem::size_of::<usize>());
    let mut acl_store = vec![0usize; acl_words];
    let acl = acl_store.as_mut_ptr().cast::<ACL>();
    if unsafe {
        InitializeAcl(
            acl,
            (acl_words * std::mem::size_of::<usize>()) as u32,
            ACL_REVISION,
        )
    } == 0
        || unsafe { AddAccessAllowedAce(acl, ACL_REVISION, GENERIC_ALL, sid) } == 0
    {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "owner-only pipe ACL failed",
        ));
    }
    let mut descriptor = [0usize; 16];
    let sd = descriptor.as_mut_ptr().cast();
    if unsafe { InitializeSecurityDescriptor(sd, SECURITY_DESCRIPTOR_REVISION) } == 0
        || unsafe { SetSecurityDescriptorDacl(sd, 1, acl, 0) } == 0
    {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "owner-only pipe descriptor failed",
        ));
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd,
        bInheritHandle: 0,
    };
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT,
            1,
            64,
            64,
            0,
            &attributes,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::from_raw_os_error(
            unsafe { GetLastError() } as i32
        ));
    }
    let mode = PIPE_NOWAIT;
    if unsafe { SetNamedPipeHandleState(handle, &mode, std::ptr::null(), std::ptr::null()) } == 0 {
        unsafe { CloseHandle(handle) };
        return Err(io::Error::from_raw_os_error(
            unsafe { GetLastError() } as i32
        ));
    }
    Ok(handle)
}

fn parse_frame(bytes: &[u8]) -> Option<UpgradeCommand> {
    match bytes {
        b"freeze\n" => Some(UpgradeCommand::Freeze),
        b"verify-frozen\n" => Some(UpgradeCommand::VerifyFrozen),
        b"release\n" => Some(UpgradeCommand::Release),
        _ => None,
    }
}

fn read_frame(handle: *mut core::ffi::c_void) -> Option<UpgradeCommand> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut bytes = [0u8; 33];
    let mut used = 0usize;
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        let mut read = 0u32;
        let ok = unsafe {
            ReadFile(
                handle,
                bytes[used..].as_mut_ptr().cast(),
                (bytes.len() - used) as u32,
                &mut read,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_NO_DATA {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            return None;
        }
        if read == 0 {
            return None;
        }
        used += read as usize;
        if used > 32 {
            return None;
        }
        if bytes[..used].contains(&b'\n') {
            return parse_frame(&bytes[..used]);
        }
    }
}

fn serve_client(handle: *mut core::ffi::c_void, sender: &SyncSender<UpgradeRequest>) {
    let Some(command) = read_frame(handle) else {
        return;
    };
    let (reply, response) = sync_channel(1);
    if sender.try_send(UpgradeRequest { command, reply }).is_err() {
        return;
    }
    let Ok(response) = response.recv_timeout(Duration::from_secs(2)) else {
        return;
    };
    let mut written = 0u32;
    let bytes = response.as_bytes();
    let _ = unsafe {
        WriteFile(
            handle,
            bytes.as_ptr().cast(),
            bytes.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        )
    };
}

pub struct UpgradeServer {
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl UpgradeServer {
    pub fn bind(key: &Path, sender: SyncSender<UpgradeRequest>) -> io::Result<Self> {
        let parent = key
            .parent()
            .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "identity parent missing"))?;
        windows_private::private_path(parent, true).map_err(|_| {
            io::Error::new(
                ErrorKind::PermissionDenied,
                "unsafe owner-local upgrade directory",
            )
        })?;
        let name = pipe_path(key)?;
        let stopping = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stopping);
        let worker = thread::Builder::new()
            .name("rca-local-upgrade".into())
            .spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    let handle = match create_owner_pipe(&name) {
                        Ok(handle) => handle,
                        Err(_) => break,
                    };
                    let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0
                        || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
                    if connected {
                        serve_client(handle, &sender);
                        unsafe { DisconnectNamedPipe(handle) };
                    } else if unsafe { GetLastError() } != ERROR_PIPE_LISTENING {
                        unsafe { CloseHandle(handle) };
                        break;
                    }
                    unsafe { CloseHandle(handle) };
                    if !connected {
                        thread::sleep(Duration::from_millis(25));
                    }
                }
            })?;
        Ok(Self {
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
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_frame, UpgradeCommand};

    #[test]
    fn node_and_powershell_upgrade_frames_are_exact() {
        assert_eq!(parse_frame(b"freeze\n"), Some(UpgradeCommand::Freeze));
        assert_eq!(
            parse_frame(b"verify-frozen\n"),
            Some(UpgradeCommand::VerifyFrozen)
        );
        assert_eq!(parse_frame(b"release\n"), Some(UpgradeCommand::Release));
    }

    #[test]
    fn malformed_or_pipelined_frames_are_rejected() {
        for frame in [
            &b"Freeze\n"[..],
            &b"freeze\r\n"[..],
            &b"freeze\nrelease\n"[..],
            &b"freeze"[..],
            &b"unknown\n"[..],
        ] {
            assert_eq!(parse_frame(frame), None, "accepted {frame:?}");
        }
    }
}
