//! One-command Linux process lifecycle proof. This unshipped, blocking
//! interface composes the existing C supervisor and bounded output drains;
//! it is not a WSS executor or a managed-session registry.
#![cfg(target_os = "linux")]

use crate::linux_output::{BoundedProcessOutput, MAX_OUTPUT_BYTES, MAX_PAGE_BYTES};
use crate::linux_supervisor::{CleanupState, SupervisorExit, SupervisorSession};
use std::io::{self, ErrorKind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const MAX_LIFETIME: Duration = Duration::from_secs(60 * 60);
const CHECK_INTERVAL: Duration = Duration::from_millis(50);
const OUTPUT_SETTLE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandEnd {
    Exited(i32),
    DeadlineExceeded,
    Cancelled,
    Unknown,
}

pub struct CommandResult {
    pub end: CommandEnd,
    pub cleanup: CleanupState,
    pub output: String,
    pub truncated: bool,
    /// Output EOF is separate from process completion. An inherited pipe may
    /// stay open after the supervised process has been reaped.
    pub output_eof: bool,
}

/// Single Node-compatible command-text contract shared by one-shot and managed execution.
pub(crate) fn valid_command_text(command: &str) -> bool {
    !command.is_empty()
        && !command.contains(char::from(0))
        && command.encode_utf16().take(8193).count() <= 8192
}

/// Preserve the installed Linux Agent's configured shell. ManagedSessions
/// still requires an absolute executable path; do not silently substitute Bash.
pub fn configured_shell() -> std::path::PathBuf {
    shell_from_environment(std::env::var_os("SHELL"))
}

fn shell_from_environment(shell: Option<std::ffi::OsString>) -> std::path::PathBuf {
    shell.map_or_else(|| "/bin/sh".into(), std::path::PathBuf::from)
}

fn output_snapshot(mut drain: BoundedProcessOutput) -> io::Result<(String, bool, bool)> {
    let deadline = Instant::now() + OUTPUT_SETTLE;
    loop {
        if drain.page(MAX_OUTPUT_BYTES, 1)?.eof || Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    drain.stop();

    let mut offset = 0;
    let mut content = String::new();
    let (truncated, eof) = loop {
        let page = drain.page(offset, MAX_PAGE_BYTES)?;
        content.push_str(&page.output);
        let done = page.next_offset == offset || page.next_offset == MAX_OUTPUT_BYTES;
        offset = page.next_offset;
        if done {
            let final_page = drain.page(offset, 1)?;
            break (page.truncated || final_page.truncated, final_page.eof);
        }
    };
    Ok((content, truncated || !eof, eof))
}

/// Execute exactly one bounded command on a disposable Linux host.
///
/// There is no caller-supplied PID. Only the C supervisor owns process-group
/// cleanup. A normal exit is reportable only after a confirmed supervisor
/// reap; errors and ambiguous cleanup never become a successful exit.
/// The stop flag is checked before launch and at most every 50 ms thereafter.
pub fn run_command(
    helper: &Path,
    shell: &Path,
    command: &str,
    lifetime: Duration,
    stop: &AtomicBool,
) -> io::Result<CommandResult> {
    if lifetime.is_zero() || lifetime > MAX_LIFETIME {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "command lifetime must be between 1ms and 60min",
        ));
    }
    // Node's parseStartProcess bounds JavaScript UTF-16 string length, not UTF-8 bytes.
    if !valid_command_text(command) {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "invalid command text",
        ));
    }
    if stop.load(Ordering::Acquire) {
        return Err(io::Error::new(
            ErrorKind::Interrupted,
            "command cancelled before launch",
        ));
    }

    let mut supervisor = SupervisorSession::start(helper, shell, command)?;
    let output = BoundedProcessOutput::attach(&mut supervisor)?;
    let deadline = Instant::now() + lifetime;
    let (reason, exit): (CommandEnd, SupervisorExit) = loop {
        if stop.load(Ordering::Acquire) {
            break (
                CommandEnd::Cancelled,
                supervisor.terminate_and_wait(Duration::from_secs(1))?,
            );
        }
        if Instant::now() >= deadline {
            break (
                CommandEnd::DeadlineExceeded,
                supervisor.terminate_and_wait(Duration::from_secs(1))?,
            );
        }
        let poll = CHECK_INTERVAL.min(deadline.saturating_duration_since(Instant::now()));
        if let Some(exited) = supervisor.wait_for_exit(poll)? {
            break (CommandEnd::Unknown, exited);
        }
    };
    let end = if exit.cleanup == CleanupState::Unknown {
        // A kill-escalated or unreaped process is never a confirmed timeout
        // or cancellation. The top-level state must itself remain Unknown.
        CommandEnd::Unknown
    } else if reason == CommandEnd::Unknown {
        exit.status
            .code()
            .map_or(CommandEnd::Unknown, CommandEnd::Exited)
    } else {
        reason
    };
    let (content, truncated, eof) = output_snapshot(output)?;
    Ok(CommandResult {
        end,
        cleanup: exit.cleanup,
        output: content,
        truncated,
        output_eof: eof,
    })
}

#[cfg(test)]
mod shell_tests {
    use super::*;
    #[test]
    fn node_shell_selection_uses_configured_value_or_sh() {
        assert_eq!(shell_from_environment(None), Path::new("/bin/sh"));
        assert_eq!(
            shell_from_environment(Some("/bin/zsh".into())),
            Path::new("/bin/zsh")
        );
        assert_eq!(shell_from_environment(Some("".into())), Path::new(""));
    }
}
