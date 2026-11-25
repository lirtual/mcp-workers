//! Public RFC 8032 test-vector seed: construct a throwaway PKCS#8 PEM
//! in memory so no private-key-shaped fixture is committed to the repository.
use ed25519_dalek::SigningKey;
use pkcs8::{EncodePrivateKey, LineEnding};

#[allow(dead_code)]
pub fn test_pem() -> String {
    let seed: [u8; 32] = [
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ];
    SigningKey::from_bytes(&seed)
        .to_pkcs8_pem(LineEnding::LF)
        .unwrap()
        .to_string()
}

#[cfg(windows)]
#[allow(dead_code)] // Common is separately compiled by tests that may not use this fixture.
pub fn seal_windows_dir(path: &std::path::Path) {
    use std::process::Command;

    // Match the already-shipped Node private user/SYSTEM DACL on a disposable
    // test parent before opening the fail-closed SQLite receipt store.
    let script = r#"
$ErrorActionPreference = 'Stop'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($userSid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($sid in @($userSid, $systemSid)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($env:RCA_TEST_PATH, $acl)
"#;
    let result = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("RCA_TEST_PATH", path)
        .output()
        .expect("disposable PowerShell test fixture");
    assert!(
        result.status.success(),
        "private ACL fixture: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[cfg(windows)]
#[allow(dead_code)] // Common is separately compiled by tests that may not use this fixture.
pub fn accept_windows_loopback(listener: &std::net::TcpListener) -> std::net::TcpStream {
    use std::io::ErrorKind;
    use std::time::{Duration, Instant};

    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                return stream;
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < deadline,
                    "local test Worker never connected"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => panic!("local test Worker accept failed: {error}"),
        }
    }
}

#[cfg(windows)]
#[allow(dead_code)] // Shared by independent Windows ACL and CLI integration tests.
pub fn seal_windows_file(path: &std::path::Path) {
    use std::process::Command;

    // An elevated Windows token may assign a newly created file to the
    // Administrators group. The installed Node contract requires the actual
    // user SID as owner, not merely a private parent DACL.
    let script = r#"
$ErrorActionPreference = 'Stop'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($userSid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($userSid, $systemSid)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $sid, [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
[IO.File]::SetAccessControl($env:RCA_TEST_PATH, $acl)
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("RCA_TEST_PATH", path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "private file ACL fixture: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Worker consumes the runtime report exactly once before executing requests.
#[allow(dead_code)]
pub fn receive_device_info(
    socket: &mut tungstenite::WebSocket<std::net::TcpStream>,
    healthy: bool,
) -> serde_json::Value {
    let text = socket.read().unwrap().into_text().unwrap();
    let info: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(info["kind"], "device_info");
    assert!(text.encode_utf16().count() <= 1200);
    assert_eq!(
        info["os"],
        if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        }
    );
    assert_eq!(
        info["capabilities"],
        if healthy {
            serde_json::json!(["read", "file_write", "shell"])
        } else {
            serde_json::json!(["read"])
        }
    );
    assert!(info.get("upgrade_protocol").is_none());
    info
}
