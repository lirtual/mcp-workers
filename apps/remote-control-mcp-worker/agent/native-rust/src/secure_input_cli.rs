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
    eprint!("Secret (input hidden): ");
    io::stderr().flush().map_err(|_| ())?;
    let guard = hide_echo()?;
    let mut value = Zeroizing::new(String::new());
    let read = io::stdin().read_line(&mut value).map_err(|_| ());
    drop(guard);
    eprintln!();
    read?;
    while value.ends_with(['\r', '\n']) {
        value.pop();
    }
    if value.is_empty() || value.len() > 8_192 || value.contains(char::from(0)) {
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
    println!(
        "Environment: {}",
        if challenge["is_production"] == true {
            "production"
        } else {
            "non-production"
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
