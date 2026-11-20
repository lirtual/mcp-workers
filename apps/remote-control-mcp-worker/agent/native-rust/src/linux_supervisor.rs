//! Linux-only Rust control for the existing, audited C session-supervisor.
//! Nonproduction candidate: no WSS dispatch, receipt admission, or installer.
//! The caller must continuously drain inherited output pipes before promotion.
#![cfg(target_os = "linux")]

use std::fs::File;
use std::io::{self, ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const READY_LIMIT: Duration = Duration::from_secs(3);
const KILL_LIMIT: Duration = Duration::from_secs(5);

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut pair = [-1; 2];
    if unsafe { libc::pipe2(pair.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(pair[0]), OwnedFd::from_raw_fd(pair[1])) })
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
                "supervisor control timeout",
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

/// The C helper is the process-group leader and owns the child-subtree
/// cleanup contract. This wrapper never sends signals to a caller-supplied PID.
pub struct SupervisorSession {
    child: Child,
    requests: Option<File>,
    responses: File,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupState {
    // The C subreaper returned only after it observed no descendants.
    Confirmed,
    // A signal-killed/abnormally exited supervisor cannot prove cleanup.
    Unknown,
}

pub struct SupervisorExit {
    pub status: ExitStatus,
    pub cleanup: CleanupState,
}

impl SupervisorExit {
    fn observed(status: ExitStatus) -> Self {
        // Exit 125 is the helper's own hard-failure sentinel. It can also be
        // a shell exit code; refusing to confirm it is the safe ambiguity.
        let cleanup = match status.code() {
            Some(code) if code != 125 => CleanupState::Confirmed,
            _ => CleanupState::Unknown,
        };
        Self { status, cleanup }
    }
}

impl SupervisorSession {
    pub fn start(helper: &Path, shell: &Path, command: &str) -> io::Result<Self> {
        if !helper.is_absolute() || !shell.is_absolute() {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "absolute native paths required",
            ));
        }
        // fd 3: Rust -> C, fd 4: C -> Rust. High duplicates prevent fd
        // collision while Command sets up its own stdin/stdout/stderr.
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
                    // pre_exec runs after fork: avoid allocator-dependent errors.
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
        let child = command_line.spawn()?;
        drop(request_read);
        drop(response_write);
        drop(request_high);
        drop(response_high);

        let mut owner = Self {
            child,
            requests: Some(File::from(request_write)),
            responses: File::from(response_read),
        };
        match read_ack(&mut owner.responses, READY_LIMIT) {
            Ok(b'R') => Ok(owner),
            _ => {
                // Lost handshake is not proof of child cleanup. Closing the
                // control pipe asks the C subreaper to kill its own group.
                owner.requests.take();
                let _ = owner.wait_bounded(KILL_LIMIT);
                Err(io::Error::other("native supervisor unavailable"))
            }
        }
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    fn wait_bounded(&mut self, duration: Duration) -> io::Result<Option<ExitStatus>> {
        let deadline = Instant::now() + duration;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    /// A confirmed cleanup requires the C subreaper to exit normally after
    /// reaping descendants. SIGKILL of the leader is always Unknown.
    pub fn terminate_and_wait(&mut self, grace: Duration) -> io::Result<SupervisorExit> {
        let control = self
            .requests
            .as_mut()
            .ok_or_else(|| io::Error::new(ErrorKind::BrokenPipe, "supervisor closed"))?;
        control.write_all(b"T")?;
        if read_ack(&mut self.responses, READY_LIMIT)? != b'O' {
            return Err(io::Error::other("supervisor did not confirm TERM"));
        }
        if let Some(status) = self.wait_bounded(grace)? {
            return Ok(SupervisorExit::observed(status));
        }
        self.requests.as_mut().unwrap().write_all(b"K")?;
        self.wait_bounded(KILL_LIMIT)?
            .map(SupervisorExit::observed)
            .ok_or_else(|| io::Error::new(ErrorKind::TimedOut, "cleanup unconfirmed"))
    }

    /// Control EOF asks the C helper to kill its group. Its own signal exit
    /// does not establish whether an escaped descendant also died.
    pub fn close_control_and_wait(&mut self, limit: Duration) -> io::Result<SupervisorExit> {
        self.requests.take();
        self.wait_bounded(limit)?
            .map(SupervisorExit::observed)
            .ok_or_else(|| io::Error::new(ErrorKind::TimedOut, "disconnect cleanup unconfirmed"))
    }
}

impl Drop for SupervisorSession {
    fn drop(&mut self) {
        self.requests.take();
        // Reap opportunistically; never signal a possibly-reused PID.
        let _ = self.wait_bounded(KILL_LIMIT);
    }
}
