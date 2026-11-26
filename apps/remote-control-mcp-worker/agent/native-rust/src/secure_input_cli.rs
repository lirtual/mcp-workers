//! Owner-local secure input terminal helpers. The secret is read only from a
//! real terminal, echo is disabled for the line, and the returned buffer wipes
//! its allocation when dropped.
use std::io::{self, IsTerminal, Write};
use zeroize::Zeroizing;

// Catch terminal interruption only while hidden input is active. The handler
// does not touch terminal state or allocate; the reader returns through RAII.
#[cfg(unix)]
mod interrupt {
    use super::SecureInputCliError;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    };

    static LOCK: Mutex<()> = Mutex::new(());
    static CANCELLED: AtomicBool = AtomicBool::new(false);
    const SIGNALS: [libc::c_int; 5] = [
        libc::SIGINT,
        libc::SIGQUIT,
        libc::SIGTERM,
        libc::SIGHUP,
        libc::SIGTSTP,
    ];

    extern "C" fn cancel(_: libc::c_int) {
        CANCELLED.store(true, Ordering::Relaxed);
    }

    pub struct Guard {
        previous: Vec<(libc::c_int, libc::sigaction)>,
        _lock: MutexGuard<'static, ()>,
    }

    impl Guard {
        pub fn new() -> Result<Self, SecureInputCliError> {
            let lock = LOCK.try_lock().map_err(|_| SecureInputCliError)?;
            CANCELLED.store(false, Ordering::Relaxed);
            let mut guard = Self {
                previous: Vec::with_capacity(SIGNALS.len()),
                _lock: lock,
            };
            let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
            action.sa_sigaction = cancel as *const () as usize;
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
            }
            for signal in SIGNALS {
                let mut previous = unsafe { std::mem::zeroed::<libc::sigaction>() };
                if unsafe { libc::sigaction(signal, &action, &mut previous) } != 0 {
                    return Err(SecureInputCliError);
                }
                guard.previous.push((signal, previous));
            }
            Ok(guard)
        }

        pub fn cancelled(&self) -> bool {
            CANCELLED.load(Ordering::Relaxed)
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            for (signal, previous) in self.previous.iter().rev() {
                unsafe {
                    libc::sigaction(*signal, previous, std::ptr::null_mut());
                }
            }
        }
    }
}

#[cfg(unix)]
fn read_terminal_line(cancel: &interrupt::Guard) -> Result<Zeroizing<String>, SecureInputCliError> {
    // Canonical input supplies one line (or EOF). A signal may flush that
    // line between poll and read, including on a different thread, so the
    // EchoGuard keeps the descriptor nonblocking until restoration.
    let mut bytes = Zeroizing::new(vec![0u8; 8_194]);
    loop {
        if cancel.cancelled() {
            return Err(SecureInputCliError);
        }
        let mut fd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut fd, 1, 100) };
        if ready < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(SecureInputCliError);
        }
        if ready == 0 {
            continue;
        }
        if cancel.cancelled() || fd.revents & libc::POLLIN == 0 {
            return Err(SecureInputCliError);
        }
        let count =
            unsafe { libc::read(libc::STDIN_FILENO, bytes.as_mut_ptr().cast(), bytes.len()) };
        if count < 0
            && matches!(
                io::Error::last_os_error().kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            )
        {
            continue;
        }
        if count <= 0 || cancel.cancelled() {
            return Err(SecureInputCliError);
        }
        let line = &bytes[..count as usize];
        // A partial/oversized canonical line or EOF is not confirmation.
        if !line.ends_with(b"\n") {
            return Err(SecureInputCliError);
        }
        return std::str::from_utf8(line)
            .map(|line| Zeroizing::new(line.to_owned()))
            .map_err(|_| SecureInputCliError);
    }
}

#[cfg(unix)]
struct EchoGuard {
    original: libc::termios,
    flags: libc::c_int,
}
#[cfg(unix)]
impl Drop for EchoGuard {
    fn drop(&mut self) {
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, &self.original);
            libc::fcntl(libc::STDIN_FILENO, libc::F_SETFL, self.flags);
        }
    }
}
#[cfg(unix)]
fn hide_echo() -> Result<EchoGuard, SecureInputCliError> {
    let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
    if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut original) } != 0 {
        return Err(SecureInputCliError);
    }
    let flags = unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(SecureInputCliError);
    }
    let guard = EchoGuard { original, flags };
    let mut hidden = guard.original;
    // This is a line-oriented interactive prompt, including in a custom tty.
    hidden.c_lflag |= libc::ICANON | libc::ISIG;
    hidden.c_lflag &= !(libc::ECHO | libc::ECHONL);
    if unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, &hidden) } != 0 {
        return Err(SecureInputCliError);
    }
    Ok(guard)
}

#[cfg(windows)]
mod windows_echo {
    use super::SecureInputCliError;
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Console::{
        FlushConsoleInputBuffer, GetConsoleMode, GetStdHandle, SetConsoleCtrlHandler,
        SetConsoleMode, CTRL_BREAK_EVENT, CTRL_C_EVENT, ENABLE_ECHO_INPUT, STD_INPUT_HANDLE,
    };

    // A console handler executes on a separate OS thread. Serialize setup,
    // normal restoration and interrupt restoration; never keep input here.
    static ACTIVE: Mutex<Option<(usize, u32)>> = Mutex::new(None);

    unsafe extern "system" fn restore_on_interrupt(event: u32) -> i32 {
        if !matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT) {
            return 0;
        }
        if let Ok(mut active) = ACTIVE.lock() {
            if let Some((handle, original)) = active.take() {
                unsafe {
                    FlushConsoleInputBuffer(handle as HANDLE);
                    SetConsoleMode(handle as HANDLE, original);
                }
                // The interrupted Owner CLI must not continue to submit.
                std::process::exit(130);
            }
        }
        0
    }

    pub struct EchoGuard;

    impl EchoGuard {
        pub fn new() -> Result<Self, SecureInputCliError> {
            let mut active = ACTIVE.lock().map_err(|_| SecureInputCliError)?;
            if active.is_some() {
                return Err(SecureInputCliError);
            }
            let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
            let mut original = 0;
            if handle.is_null()
                || unsafe { GetConsoleMode(handle, &mut original) } == 0
                || unsafe { SetConsoleCtrlHandler(Some(restore_on_interrupt), 1) } == 0
            {
                return Err(SecureInputCliError);
            }
            if unsafe { SetConsoleMode(handle, original & !ENABLE_ECHO_INPUT) } == 0 {
                unsafe {
                    SetConsoleCtrlHandler(Some(restore_on_interrupt), 0);
                }
                return Err(SecureInputCliError);
            }
            *active = Some((handle as usize, original));
            Ok(Self)
        }
    }

    impl Drop for EchoGuard {
        fn drop(&mut self) {
            if let Ok(mut active) = ACTIVE.lock() {
                if let Some((handle, original)) = active.take() {
                    unsafe {
                        SetConsoleMode(handle as HANDLE, original);
                    }
                }
                unsafe {
                    SetConsoleCtrlHandler(Some(restore_on_interrupt), 0);
                }
            }
        }
    }
}

#[cfg(windows)]
fn hide_echo() -> Result<windows_echo::EchoGuard, SecureInputCliError> {
    windows_echo::EchoGuard::new()
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
    #[cfg(unix)]
    let cancel = interrupt::Guard::new()?;
    let guard = hide_echo()?;
    eprint!("Secret (input hidden): ");
    io::stderr().flush().map_err(|_| ())?;
    #[cfg(unix)]
    let read = read_terminal_line(&cancel);
    #[cfg(windows)]
    let read = {
        let mut value = Zeroizing::new(String::new());
        io::stdin()
            .read_line(&mut value)
            .map(|_| value)
            .map_err(|_| SecureInputCliError)
    };
    drop(guard);
    #[cfg(unix)]
    {
        let cancelled = cancel.cancelled();
        drop(cancel);
        if cancelled {
            eprintln!();
            return Err(SecureInputCliError);
        }
    }
    eprintln!();
    let mut value = read?;
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
    run_owner_flow(&client, pem, device_id, request_id)
}

fn run_owner_flow(
    client: &crate::device_pairing::PairingClient,
    pem: &str,
    device_id: &str,
    request_id: &str,
) -> Result<(), SecureInputCliError> {
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
            // A Darwin controlling PTY can be revoked when its session leader
            // exits. Verify restoration while this process still owns it.
            let flags_before = stdin_flags();
            let mode_before = stdin_mode();
            let result = read_hidden_secret();
            assert_eq!(stdin_mode(), mode_before);
            assert_eq!(
                stdin_flags() & libc::O_NONBLOCK,
                flags_before & libc::O_NONBLOCK
            );
            if std::env::var_os("RCA_TEST_CANCEL_HIDDEN_INPUT").is_some() {
                assert!(result.is_err());
            } else {
                assert!(result.is_ok_and(|value| value.as_str() == MARKER));
            }
        }
    }

    #[test]
    #[ignore = "spawned by the real PTY Owner flow test"]
    fn owner_flow_fixture() {
        use std::io::IsTerminal;
        let port = std::env::var("RCA_TEST_OWNER_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let pem = std::env::var("RCA_TEST_OWNER_PEM").unwrap();
        let owner = std::env::var("RCA_TEST_OWNER_DEVICE").unwrap();
        let request = std::env::var("RCA_TEST_OWNER_REQUEST").unwrap();
        assert!(io::stdin().is_terminal(), "fixture stdin is not a terminal");
        assert!(
            io::stdout().is_terminal(),
            "fixture stdout is not a terminal"
        );
        let client = crate::device_pairing::PairingClient::loopback_test_client(port);
        run_owner_flow(&client, &pem, &owner, &request).unwrap();
    }

    #[test]
    fn real_pty_owner_flow_displays_target_hides_secret_and_submits_once() {
        use crate::session_recovery::tests::{recv_request, reply};
        use serde_json::json;
        use std::net::TcpListener;
        use std::time::{SystemTime, UNIX_EPOCH};

        const OWNER: &str = "123e4567-e89b-42d3-a456-426614174001";
        const REQUEST: &str = "123e4567-e89b-42d3-a456-426614174002";
        const TARGET: &str = "123e4567-e89b-42d3-a456-426614174003";
        const NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAAAA";
        const BINDING: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const SECRET: &str = "synthetic-secure-input-pty-1039";

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pem = crate::device_pairing::generate_private_pem().unwrap();
        let expected_pem = pem.clone();
        let expiry = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let (route, request) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/owner/intent/challenge HTTP/1.1");
            assert_eq!(
                request,
                json!({"action":"secure_input","device_id":OWNER,"request_id":REQUEST})
            );
            reply(
                &mut socket,
                "200 OK",
                json!({
                    "action":"secure_input","device_id":OWNER,"request_id":REQUEST,
                    "nonce":NONCE,"generation":3,"expires_at":expiry,"target_binding":BINDING,
                    "purpose":"Synthetic task input",
                    "target":{"kind":"task_process","session_id":TARGET,"name":"SECURE_INPUT_FIXTURE"},
                    "execution":{"device_id":TARGET,"grant_type":"session","session_attempt_id":REQUEST,
                        "session_run_id":123,"session_run_attempt":1,"session_workflow_name":"ubuntu",
                        "expires_at":expiry},
                    "is_production":false
                }),
            );

            let (mut socket, _) = listener.accept().unwrap();
            let (route, request) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/owner/intent HTTP/1.1");
            let proof = crate::identity::signed_secure_input_owner_intent_proof(
                &expected_pem,
                REQUEST,
                OWNER,
                NONCE,
                3,
                BINDING,
                true,
                false,
            )
            .unwrap();
            assert_eq!(
                request,
                json!({
                    "action":"secure_input","device_id":OWNER,"request_id":REQUEST,
                    "nonce":NONCE,"generation":3,"target_confirmed":true,
                    "production_authorized":false,"proof":proof,"secret":SECRET
                })
            );
            reply(
                &mut socket,
                "200 OK",
                json!({"request_id":REQUEST,"state":"unknown"}),
            );
        });

        let (mut master_fd, mut slave_fd) = (-1, -1);
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master_fd,
                    &mut slave_fd,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let mut master = unsafe { File::from_raw_fd(master_fd) };
        let slave = unsafe { File::from_raw_fd(slave_fd) };
        let mut child = ScopedChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "secure_input_cli::terminal_tests::owner_flow_fixture",
                    "--ignored",
                    "--nocapture",
                ])
                .env("RCA_TEST_OWNER_PORT", port.to_string())
                .env("RCA_TEST_OWNER_PEM", pem)
                .env("RCA_TEST_OWNER_DEVICE", OWNER)
                .env("RCA_TEST_OWNER_REQUEST", REQUEST)
                .stdin(Stdio::from(slave.try_clone().unwrap()))
                .stdout(Stdio::from(slave.try_clone().unwrap()))
                .stderr(Stdio::from(slave.try_clone().unwrap()))
                .spawn()
                .unwrap(),
        );

        let deadline = Instant::now() + Duration::from_secs(8);
        let mut output = Vec::new();
        let mut confirmed = false;
        let mut secret_sent = false;
        loop {
            assert!(Instant::now() < deadline, "Owner CLI PTY timed out");
            let mut poll = libc::pollfd {
                fd: master.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut poll, 1, 50) };
            if ready > 0 && poll.revents & libc::POLLIN != 0 {
                let mut buffer = [0; 4096];
                let count = match master.read(&mut buffer) {
                    Ok(count) => count,
                    Err(error) if error.raw_os_error() == Some(libc::EIO) => 0,
                    Err(error) => panic!("Owner CLI PTY read: {error}"),
                };
                if count > 0 {
                    output.extend_from_slice(&buffer[..count]);
                    assert!(output.len() < 64 * 1024);
                    let visible = String::from_utf8_lossy(&output);
                    if !confirmed
                        && visible
                            .contains("Type CONFIRM TARGET to confirm the exact target above: ")
                    {
                        assert!(visible.contains(OWNER));
                        assert!(visible.contains(TARGET));
                        assert!(visible.contains("SECURE_INPUT_FIXTURE"));
                        assert!(visible.contains("\"session_run_id\":123"));
                        master.write_all(b"CONFIRM TARGET\n").unwrap();
                        confirmed = true;
                    }
                    if confirmed && !secret_sent && visible.contains("Secret (input hidden): ") {
                        assert_eq!(terminal_flags(&slave) & (libc::ECHO | libc::ECHONL), 0);
                        master.write_all(SECRET.as_bytes()).unwrap();
                        master.write_all(b"\n").unwrap();
                        secret_sent = true;
                    }
                } else if let Some(status) = child.0.try_wait().unwrap() {
                    assert!(
                        status.success(),
                        "Owner CLI helper failed: {status}; output={}",
                        String::from_utf8_lossy(&output)
                    );
                    break;
                }
            }
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "Owner CLI helper failed: {status}; output={}",
                    String::from_utf8_lossy(&output)
                );
                if ready <= 0 || poll.revents & libc::POLLIN == 0 {
                    break;
                }
            }
        }
        assert!(confirmed && secret_sent);
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("Synthetic task input"));
        assert!(output.contains("SECURE_INPUT_FIXTURE"));
        assert!(output.contains("Submitted once."));
        assert!(
            !output.contains(SECRET),
            "secret appeared in terminal output"
        );
        server.join().unwrap();
    }

    fn stdin_mode() -> libc::tcflag_t {
        let mut settings = unsafe { std::mem::zeroed::<libc::termios>() };
        assert_eq!(
            unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut settings) },
            0
        );
        settings.c_lflag
    }

    fn stdin_flags() -> libc::c_int {
        let flags = unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_GETFL) };
        assert!(flags >= 0);
        flags
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
        check_pty(false);
    }

    #[test]
    fn real_pty_interrupt_cancels_and_restores_terminal() {
        check_pty(true);
    }

    fn check_pty(cancel: bool) {
        use std::os::unix::process::CommandExt;
        let (mut master_fd, mut slave_fd) = (-1, -1);
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master_fd,
                    &mut slave_fd,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let mut master = unsafe { File::from_raw_fd(master_fd) };
        let slave = unsafe { File::from_raw_fd(slave_fd) };
        let original = terminal_flags(&slave);
        let original_fd_flags = unsafe { libc::fcntl(slave.as_raw_fd(), libc::F_GETFL) };
        assert_ne!(original & libc::ECHO, 0);
        let mut command = Command::new(std::env::current_exe().unwrap());
        if cancel {
            command.env("RCA_TEST_CANCEL_HIDDEN_INPUT", "1");
            // A real foreground controlling terminal delivers VINTR as SIGINT.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1
                        || libc::ioctl(libc::STDIN_FILENO, libc::TIOCSCTTY as _, 0) == -1
                        || libc::tcsetpgrp(libc::STDIN_FILENO, libc::getpgrp()) == -1
                    {
                        return Err(io::Error::last_os_error());
                    }
                    let mut signals = std::mem::zeroed::<libc::sigset_t>();
                    libc::sigemptyset(&mut signals);
                    libc::sigaddset(&mut signals, libc::SIGINT);
                    let error =
                        libc::pthread_sigmask(libc::SIG_UNBLOCK, &signals, std::ptr::null_mut());
                    if error != 0 {
                        return Err(io::Error::from_raw_os_error(error));
                    }
                    Ok(())
                });
            }
        }
        let mut child = ScopedChild(
            command
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
            assert!(
                Instant::now() < deadline,
                "synthetic PTY timed out: input_sent={submitted}"
            );
            let mut poll = libc::pollfd {
                fd: master.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut poll, 1, 50) };
            if ready > 0 && poll.revents & libc::POLLIN != 0 {
                let mut buffer = [0; 4096];
                let count = match master.read(&mut buffer) {
                    Ok(count) => count,
                    // Once the controlling session exits, a PTY master may
                    // return EOF or EIO even while poll reports readable.
                    Err(error) if error.raw_os_error() == Some(libc::EIO) => 0,
                    Err(error) => panic!("synthetic PTY read: {error}"),
                };
                if count == 0 {
                    if let Some(status) = child.0.try_wait().unwrap() {
                        assert!(status.success(), "terminal helper failed: {status}");
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                output.extend_from_slice(&buffer[..count]);
                assert!(output.len() < 64 * 1024);
                if !submitted
                    && output
                        .windows(b"Secret (input hidden): ".len())
                        .any(|window| window == b"Secret (input hidden): ")
                {
                    assert_eq!(terminal_flags(&slave) & (libc::ECHO | libc::ECHONL), 0);
                    let mut settings = unsafe { std::mem::zeroed::<libc::termios>() };
                    assert_eq!(
                        unsafe { libc::tcgetattr(slave.as_raw_fd(), &mut settings) },
                        0
                    );
                    let interrupt = [settings.c_cc[libc::VINTR]];
                    if cancel {
                        assert_eq!(settings.c_lflag & libc::ISIG, libc::ISIG);
                        assert_eq!(interrupt, [3], "fixture must use Ctrl+C as VINTR");
                    }
                    master.write_all(MARKER.as_bytes()).unwrap();
                    master
                        .write_all(if cancel { &interrupt } else { b"\n" })
                        .unwrap();
                    submitted = true;
                }
            }
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "terminal helper did not return normally: {status}"
                );
                // Drain any final readable output, but a closed controlling
                // session may keep reporting HUP rather than timing out.
                if ready <= 0 || poll.revents & libc::POLLIN == 0 {
                    break;
                }
            }
        }
        assert!(submitted);
        // Non-controlling PTYs remain available for an independent parent
        // readback; the cancelling child already verified restoration before
        // its controlling session could be revoked.
        if !cancel {
            assert_eq!(terminal_flags(&slave), original);
            assert_eq!(
                unsafe { libc::fcntl(slave.as_raw_fd(), libc::F_GETFL) } & libc::O_NONBLOCK,
                original_fd_flags & libc::O_NONBLOCK
            );
        }
        assert!(!output
            .windows(MARKER.len())
            .any(|window| window == MARKER.as_bytes()));
    }
}

#[cfg(all(test, windows))]
mod windows_terminal_tests {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::os::windows::{io::AsRawHandle, process::CommandExt};
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::Console::{
        GenerateConsoleCtrlEvent, GetConsoleMode, GetStdHandle, SetConsoleCtrlHandler,
        SetStdHandle, CTRL_C_EVENT, ENABLE_ECHO_INPUT, STD_ERROR_HANDLE, STD_INPUT_HANDLE,
        STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::Threading::CREATE_NEW_CONSOLE;

    unsafe extern "system" fn keep_test_observer(event: u32) -> i32 {
        i32::from(event == CTRL_C_EVENT)
    }

    fn console_handles() -> (File, File) {
        // CI may redirect inherited standard streams even with a new console.
        let input = OpenOptions::new()
            .read(true)
            .write(true)
            .open("CONIN$")
            .unwrap();
        let output = OpenOptions::new()
            .read(true)
            .write(true)
            .open("CONOUT$")
            .unwrap();
        unsafe {
            assert_ne!(SetStdHandle(STD_INPUT_HANDLE, input.as_raw_handle()), 0);
            assert_ne!(SetStdHandle(STD_OUTPUT_HANDLE, output.as_raw_handle()), 0);
            assert_ne!(SetStdHandle(STD_ERROR_HANDLE, output.as_raw_handle()), 0);
        }
        (input, output)
    }

    fn mode() -> u32 {
        let mut value = 0;
        assert_ne!(
            unsafe { GetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), &mut value) },
            0
        );
        value
    }

    // Each fixture is a bounded child. A disposable console is shared by
    // the observer and the CLI reader, never by the CI runner.
    struct ScopedChild(Child);
    impl Drop for ScopedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn wait_for_exit(child: &mut Child, seconds: u64) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "console fixture timed out");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn real_console_interrupt_restores_mode() {
        const ROLE: &str = "RCA_TEST_CONSOLE_INTERRUPT_ROLE";
        const TEST: &str =
            "secure_input_cli::windows_terminal_tests::real_console_interrupt_restores_mode";
        match std::env::var(ROLE).as_deref() {
            Ok("reader") => {
                let _console = console_handles();
                assert_ne!(unsafe { SetConsoleCtrlHandler(None, 0) }, 0);
                let _ = read_hidden_secret();
                panic!("reader must not continue after interrupt");
            }
            Ok("observer") => {
                let _console = console_handles();
                assert_ne!(
                    unsafe { SetConsoleCtrlHandler(Some(keep_test_observer), 1) },
                    0
                );
                let original = mode();
                assert_ne!(original & ENABLE_ECHO_INPUT, 0);
                let mut reader = ScopedChild(
                    Command::new(std::env::current_exe().unwrap())
                        .args(["--exact", TEST, "--nocapture"])
                        .env(ROLE, "reader")
                        .spawn()
                        .unwrap(),
                );
                let deadline = Instant::now() + Duration::from_secs(5);
                while mode() & ENABLE_ECHO_INPUT != 0 {
                    assert!(reader.0.try_wait().unwrap().is_none());
                    assert!(Instant::now() < deadline, "reader did not hide echo");
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert_ne!(unsafe { GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) }, 0);
                let status = wait_for_exit(&mut reader.0, 10);
                assert_eq!(mode(), original, "interrupted reader left console altered");
                assert_eq!(status.code(), Some(130));
            }
            _ => {
                let mut observer = ScopedChild(
                    Command::new(std::env::current_exe().unwrap())
                        .args(["--exact", TEST, "--nocapture"])
                        .env(ROLE, "observer")
                        .creation_flags(CREATE_NEW_CONSOLE)
                        .spawn()
                        .unwrap(),
                );
                assert!(wait_for_exit(&mut observer.0, 20).success());
            }
        }
    }
}
