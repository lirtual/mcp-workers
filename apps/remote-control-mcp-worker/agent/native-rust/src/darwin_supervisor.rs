//! Nonproduction macOS owner-group bridge to the existing Darwin C helper.
//! Unlike Linux's subreaper, this can prove cleanup only within the anchored
//! process group. Escaped setsid descendants are never claimed as stopped.
//! No installer, device identity, receipt admission, or Worker dispatch.
#![cfg(target_os = "macos")]

use std::fs::File;
use std::io::{self, ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const READY_LIMIT: Duration = Duration::from_secs(3);
const KILL_LIMIT: Duration = Duration::from_secs(5);

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut pair = [-1; 2];
    if unsafe { libc::pipe(pair.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { OwnedFd::from_raw_fd(pair[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(pair[1]) };
    for fd in [&read, &write] {
        let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
        if flags < 0
            || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok((read, write))
}

fn high_duplicate(fd: &OwnedFd) -> io::Result<OwnedFd> {
    let value = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if value < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(value) })
}

fn read_ack(file: &mut File, limit: Duration) -> io::Result<u8> {
    let deadline = Instant::now() + limit;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                ErrorKind::TimedOut,
                "Darwin supervisor timeout",
            ));
        }
        let mut candidate = libc::pollfd {
            fd: file.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        let timeout = remaining.as_millis().min(i32::MAX as u128) as i32;
        let result = unsafe { libc::poll(&mut candidate, 1, timeout) };
        if result > 0 {
            let mut byte = [0];
            file.read_exact(&mut byte)?;
            return Ok(byte[0]);
        }
        if result < 0 && io::Error::last_os_error().kind() != ErrorKind::Interrupted {
            return Err(io::Error::last_os_error());
        }
    }
}

/// The helper's live anchor, not Rust, is the only process allowed to signal
/// its own PGID. A dropped control pipe causes the helper to self-terminate.
pub struct DarwinSupervisorSession {
    monitor: Child,
    requests: Option<File>,
    responses: File,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroupCleanup {
    /// The audited C helper confirmed termination of its *owned group* only.
    OwnedGroupStopped,
    /// Control was lost or monitor status is ambiguous; no cleanup promise.
    Unknown,
}

pub struct DarwinSupervisorExit {
    pub status: ExitStatus,
    pub group_cleanup: GroupCleanup,
}

impl DarwinSupervisorExit {
    fn observed(status: ExitStatus) -> Self {
        let group_cleanup = match status.code() {
            // 125 is the C helper failure sentinel and a possible shell exit.
            Some(code) if code != 125 => GroupCleanup::OwnedGroupStopped,
            _ => GroupCleanup::Unknown,
        };
        Self {
            status,
            group_cleanup,
        }
    }
}

impl DarwinSupervisorSession {
    pub fn start(helper: &Path, shell: &Path, command: &str) -> io::Result<Self> {
        if !helper.is_absolute() || !matches!(shell.to_str(), Some("/bin/sh" | "/bin/zsh")) {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "trusted absolute Darwin helper and supported shell required",
            ));
        }
        let (request_read, request_write) = pipe()?;
        let (response_read, response_write) = pipe()?;
        let request_high = high_duplicate(&request_read)?;
        let response_high = high_duplicate(&response_write)?;
        let from = request_high.as_raw_fd();
        let to = response_high.as_raw_fd();
        let mut command_line = Command::new(helper);
        command_line
            .arg(shell)
            .arg(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        unsafe {
            command_line.pre_exec(move || {
                if libc::getpid() != libc::getpgrp() {
                    return Err(io::Error::from_raw_os_error(libc::EPERM));
                }
                if libc::dup2(from, 3) < 0 || libc::dup2(to, 4) < 0 {
                    return Err(io::Error::last_os_error());
                }
                libc::close(from);
                libc::close(to);
                Ok(())
            });
        }
        let monitor = command_line.spawn()?;
        drop(request_read);
        drop(response_write);
        drop(request_high);
        drop(response_high);
        let mut owner = Self {
            monitor,
            requests: Some(File::from(request_write)),
            responses: File::from(response_read),
        };
        match read_ack(&mut owner.responses, READY_LIMIT) {
            Ok(b'R') => Ok(owner),
            _ => {
                owner.requests.take();
                let _ = owner.wait_bounded(KILL_LIMIT);
                Err(io::Error::other("Darwin owner-group helper refused launch"))
            }
        }
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.monitor.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.monitor.stderr.take()
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.monitor.stdin.take()
    }

    fn wait_bounded(&mut self, limit: Duration) -> io::Result<Option<ExitStatus>> {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = self.monitor.try_wait()? {
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn wait_for_exit(&mut self, limit: Duration) -> io::Result<Option<DarwinSupervisorExit>> {
        Ok(self
            .wait_bounded(limit)?
            .map(DarwinSupervisorExit::observed))
    }

    pub fn terminate_and_wait(&mut self, grace: Duration) -> io::Result<DarwinSupervisorExit> {
        let control = self
            .requests
            .as_mut()
            .ok_or_else(|| io::Error::new(ErrorKind::BrokenPipe, "Darwin control closed"))?;
        control.write_all(b"T")?;
        if read_ack(&mut self.responses, READY_LIMIT)? != b'O' {
            return Err(io::Error::other("Darwin group TERM not acknowledged"));
        }
        if let Some(status) = self.wait_bounded(grace)? {
            return Ok(DarwinSupervisorExit::observed(status));
        }
        self.requests.as_mut().unwrap().write_all(b"K")?;
        self.wait_bounded(KILL_LIMIT)?
            .map(DarwinSupervisorExit::observed)
            .ok_or_else(|| io::Error::new(ErrorKind::TimedOut, "Darwin cleanup unconfirmed"))
    }

    /// EOF asks the anchor to kill its group; loss of the monitor's protocol
    /// cannot turn this into confirmed cleanup.
    pub fn close_control_and_wait(&mut self, limit: Duration) -> io::Result<DarwinSupervisorExit> {
        self.requests.take();
        self.wait_bounded(limit)?
            .map(DarwinSupervisorExit::observed)
            .ok_or_else(|| io::Error::new(ErrorKind::TimedOut, "Darwin cleanup unconfirmed"))
    }
}

impl Drop for DarwinSupervisorSession {
    fn drop(&mut self) {
        self.requests.take();
        // No numeric-PID signalling. Reap only after C owns group teardown.
        let _ = self.wait_bounded(KILL_LIMIT);
    }
}
