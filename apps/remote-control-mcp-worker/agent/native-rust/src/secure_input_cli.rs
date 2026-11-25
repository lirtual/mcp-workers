//! Owner-local secure input terminal helpers. The secret is read only from a
//! real terminal, echo is disabled for the line, and the returned buffer wipes
//! its allocation when dropped.
use std::io::{self, IsTerminal, Write};
use zeroize::Zeroizing;

#[cfg(unix)]
struct EchoGuard {
    original: libc::termios,
}
#[cfg(unix)]
impl Drop for EchoGuard {
    fn drop(&mut self) {
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, &self.original);
        }
    }
}
#[cfg(unix)]
fn hide_echo() -> Result<EchoGuard, SecureInputCliError> {
    let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
    if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut original) } != 0 {
        return Err(SecureInputCliError);
    }
    let mut hidden = original;
    hidden.c_lflag &= !(libc::ECHO | libc::ECHONL);
    if unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, &hidden) } != 0 {
        return Err(SecureInputCliError);
    }
    Ok(EchoGuard { original })
}

#[cfg(windows)]
struct EchoGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
    original: u32,
}
#[cfg(windows)]
impl Drop for EchoGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Console::SetConsoleMode(self.handle, self.original);
        }
    }
}
#[cfg(windows)]
fn hide_echo() -> Result<EchoGuard, SecureInputCliError> {
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_ECHO_INPUT, STD_INPUT_HANDLE,
    };
    let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    if handle.is_null() {
        return Err(SecureInputCliError);
    }
    let mut original = 0u32;
    if unsafe { GetConsoleMode(handle, &mut original) } == 0
        || unsafe { SetConsoleMode(handle, original & !ENABLE_ECHO_INPUT) } == 0
    {
        return Err(SecureInputCliError);
    }
    Ok(EchoGuard { handle, original })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecureInputCliError;

impl From<()> for SecureInputCliError {
    fn from(_: ()) -> Self {
        Self
    }
}

pub fn confirm(prompt: &str, expected: &str) -> Result<bool, SecureInputCliError> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(SecureInputCliError);
    }
    print!("{prompt}");
    io::stdout().flush().map_err(|_| ())?;
    let mut response = String::new();
    io::stdin().read_line(&mut response).map_err(|_| ())?;
    while response.ends_with(['\r', '\n']) {
        response.pop();
    }
    Ok(response == expected)
}

pub fn read_hidden_secret() -> Result<Zeroizing<String>, SecureInputCliError> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(SecureInputCliError);
    }
    let guard = hide_echo()?;
    eprint!("Secret (input hidden): ");
    io::stderr().flush().map_err(|_| ())?;
    let mut value = Zeroizing::new(String::new());
    let read = io::stdin().read_line(&mut value).map_err(|_| ());
    drop(guard);
    eprintln!();
    read?;
    while value.ends_with(['\r', '\n']) {
        value.pop();
    }
    if value.trim().is_empty() || value.len() > 8_192 || value.contains(char::from(0)) {
        return Err(SecureInputCliError);
    }
    Ok(value)
}

/// Run the local Owner-only terminal flow. A failed submit is never retried
/// here: the user must query the same request ID to resolve an ambiguous
/// transport result.
pub fn run_secure_input_owner_flow(
    endpoint: &str,
    pem: &str,
    device_id: &str,
    request_id: &str,
) -> Result<(), SecureInputCliError> {
    use crate::device_pairing::PairingClient;
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(SecureInputCliError);
    }
    let client = PairingClient::new(endpoint).map_err(|_| ())?;
    let challenge = client
        .secure_input_challenge(pem, device_id, request_id)
        .map_err(|_| ())?;

    println!("Secure input Owner confirmation");
    println!("Request: {request_id}");
    println!("Owner device: {device_id}");
    println!("Purpose: {}", challenge["purpose"].as_str().ok_or(())?);
    println!(
        "Target: {}",
        serde_json::to_string(&challenge["target"]).map_err(|_| ())?
    );
    println!(
        "Execution: {}",
        serde_json::to_string(&challenge["execution"]).map_err(|_| ())?
    );
    if !challenge["provider_principal"].is_null() {
        println!(
            "Provider principal: {}",
            serde_json::to_string(&challenge["provider_principal"]).map_err(|_| ())?
        );
    }
    let (effect, recovery) = match challenge["target"]["kind"].as_str() {
        Some("task_process") => (
            "Deliver once to the named process stdin. All captured output for that session is permanently suppressed. Use only a trusted target process.",
            "Delivered bytes cannot be recalled; the process lifetime bounds future reuse.",
        ),
        Some("github_repository_secret" | "github_environment_secret") => (
            "Set or replace the named GitHub Secret at the displayed repository or Environment. This does not deploy code by itself.",
            "The old Secret cannot be read back; recover by replacing or removing it.",
        ),
        Some("github_repository_variable" | "github_environment_variable") => (
            "Set or replace the named GitHub Variable at the displayed repository or Environment. This does not deploy code by itself.",
            "Recover by restoring the prior Variable value or removing it.",
        ),
        Some("cloudflare_worker_secret") => match challenge["target"]["mode"].as_str() {
            Some("deploy") => (
                "Set the Worker Secret and immediately create and deploy a new Worker version.",
                "The old Secret cannot be read back; replace it and separately restore a known-good version if needed.",
            ),
            Some("version") => (
                "Set the Worker Secret on a new version without deploying it.",
                "The new version stays inactive until separately deployed; the old Secret cannot be read back.",
            ),
            _ => return Err(SecureInputCliError),
        },
        _ => return Err(SecureInputCliError),
    };
    println!("Effect: {effect}");
    println!("Recovery: {recovery}");
    println!(
        "Environment: {}",
        if challenge["is_production"] == true {
            "production"
        } else {
            "caller marked non-production; verify the exact resource"
        }
    );
    if !confirm(
        "Type CONFIRM TARGET to confirm the exact target above: ",
        "CONFIRM TARGET",
    )? {
        return Err(SecureInputCliError);
    }
    let production = challenge["is_production"] == true;
    if production
        && !confirm(
            "This is a production write. Type AUTHORIZE PRODUCTION to authorize it: ",
            "AUTHORIZE PRODUCTION",
        )?
    {
        return Err(SecureInputCliError);
    }
    let secret = read_hidden_secret()?;
    match client.secure_input_owner_intent(pem, device_id, &challenge, &secret, true, production) {
        Ok(()) => {
            println!("Submitted once. Check status for this same request ID: {request_id}");
            Ok(())
        }
        Err(_) => {
            eprintln!(
                "No successful confirmation received. Check status for this same request ID; do not submit it again."
            );
            Err(SecureInputCliError)
        }
    }
}

#[cfg(all(test, unix))]
mod terminal_tests {
    use super::*;
    use std::fs::File;
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    const MARKER: &str = "synthetic-pty-marker-é";

    #[test]
    fn hidden_input_fixture() {
        if std::env::var_os("RCA_TEST_HIDDEN_INPUT_FIXTURE").is_some() {
            assert!(read_hidden_secret().is_ok_and(|value| value.as_str() == MARKER));
        }
    }

    struct ScopedChild(Child);
    impl Drop for ScopedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn terminal_flags(file: &File) -> libc::tcflag_t {
        let mut settings = unsafe { std::mem::zeroed::<libc::termios>() };
        assert_eq!(
            unsafe { libc::tcgetattr(file.as_raw_fd(), &mut settings) },
            0
        );
        settings.c_lflag
    }

    #[test]
    fn real_pty_prompt_is_hidden_and_terminal_is_restored() {
        let (mut master_fd, mut slave_fd) = (-1, -1);
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master_fd,
                    &mut slave_fd,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            0
        );
        let mut master = unsafe { File::from_raw_fd(master_fd) };
        let slave = unsafe { File::from_raw_fd(slave_fd) };
        let original = terminal_flags(&slave);
        assert_ne!(original & libc::ECHO, 0);
        let mut child = ScopedChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "secure_input_cli::terminal_tests::hidden_input_fixture",
                    "--nocapture",
                ])
                .env("RCA_TEST_HIDDEN_INPUT_FIXTURE", "1")
                .stdin(Stdio::from(slave.try_clone().unwrap()))
                .stdout(Stdio::from(slave.try_clone().unwrap()))
                .stderr(Stdio::from(slave.try_clone().unwrap()))
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        let mut submitted = false;
        loop {
            assert!(Instant::now() < deadline, "synthetic PTY test timed out");
            let mut poll = libc::pollfd {
                fd: master.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut poll, 1, 50) };
            if ready > 0 && poll.revents & libc::POLLIN != 0 {
                let mut buffer = [0; 4096];
                let count = master.read(&mut buffer).unwrap();
                output.extend_from_slice(&buffer[..count]);
                assert!(output.len() < 64 * 1024);
                if !submitted
                    && output
                        .windows(b"Secret (input hidden): ".len())
                        .any(|window| window == b"Secret (input hidden): ")
                {
                    assert_eq!(terminal_flags(&slave) & (libc::ECHO | libc::ECHONL), 0);
                    master.write_all(MARKER.as_bytes()).unwrap();
                    master.write_all(b"\n").unwrap();
                    submitted = true;
                }
            }
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                // Drain any final output before checking the synthetic marker.
                if ready == 0 {
                    break;
                }
            }
        }
        assert!(submitted);
        assert_eq!(terminal_flags(&slave), original);
        assert!(!output
            .windows(MARKER.len())
            .any(|window| window == MARKER.as_bytes()));
    }
}
