//! Physical Windows job ownership and fail-closed lifecycle in a disposable CI.
//! No real RCA identity, Worker, installation, or remote command entrypoint.
#![cfg(windows)]

use rca_native_agent::windows_job::{JobCleanup, WindowsJobSession};
use std::fs;
use std::time::{Duration, Instant};

#[test]
fn normal_powershell_exit_is_observed_without_claiming_descendant_cleanup() {
    let owner = WindowsJobSession::start("exit 7").unwrap();
    assert_eq!(
        owner.wait_for_exit(Duration::from_secs(10)).unwrap(),
        Some(7)
    );
    assert_eq!(
        owner.terminate_and_wait(Duration::from_secs(3)).unwrap(),
        JobCleanup::Confirmed
    );
}

#[test]
fn bounded_stop_terminates_owned_powershell_without_numeric_pid_signals() {
    let owner = WindowsJobSession::start("Start-Sleep -Seconds 30").unwrap();
    assert_eq!(
        owner.wait_for_exit(Duration::from_millis(100)).unwrap(),
        None
    );
    assert!(owner.active_processes().unwrap() >= 1);
    assert_eq!(
        owner.terminate_and_wait(Duration::from_secs(5)).unwrap(),
        JobCleanup::Confirmed
    );
    assert!(owner
        .wait_for_exit(Duration::from_secs(2))
        .unwrap()
        .is_some());
}

#[test]
fn private_job_owns_powershell_createprocess_descendants() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("child-pid.txt");
    let literal_path = marker.to_string_lossy().replace('\'', "''");
    // Use .NET CreateProcess (UseShellExecute=false). Brokered WMI/ShellExecute
    // process creation is not covered by this job membership proof.
    let script = format!(
        r#"
$p = [Diagnostics.Process]::new()
$p.StartInfo.FileName = "$PSHOME\powershell.exe"
$p.StartInfo.Arguments = "-NoProfile -NonInteractive -Command Start-Sleep -Seconds 30"
$p.StartInfo.UseShellExecute = $false
if (-not $p.Start()) {{ throw 'child failed to launch' }}
[IO.File]::WriteAllText('{literal_path}', $p.Id.ToString())
Start-Sleep -Seconds 30
"#
    );
    let owner = WindowsJobSession::start(&script).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.is_file() {
        assert!(
            Instant::now() < deadline,
            "owned parent did not spawn child before deadline"
        );
        std::thread::sleep(Duration::from_millis(30));
    }
    assert!(fs::read_to_string(&marker)
        .unwrap()
        .trim()
        .parse::<u32>()
        .is_ok());
    assert!(
        owner.active_processes().unwrap() >= 2,
        "private job must own both parent and CreateProcess child"
    );
    assert_eq!(
        owner.terminate_and_wait(Duration::from_secs(5)).unwrap(),
        JobCleanup::Confirmed
    );
}

#[test]
fn invalid_command_is_rejected_before_any_process_creation() {
    assert!(WindowsJobSession::start("").is_err());
    assert!(WindowsJobSession::start("echo before\0after").is_err());
    let oversized = "a".repeat(8193);
    assert!(WindowsJobSession::start(&oversized).is_err());
}

#[test]
fn restricted_stdio_round_trip_and_true_eof_after_exit() {
    use std::io::{Read, Write};

    let (job, mut io) = WindowsJobSession::start_with_stdio(
        "$value = [Console]::ReadLine(); [Console]::Out.WriteLine('OUT:' + $value); [Console]::Error.WriteLine('ERR:' + $value)",
    )
    .unwrap();
    io.stdin.write_all(b"hello\n").unwrap();
    drop(io.stdin);
    assert_eq!(job.wait_for_exit(Duration::from_secs(10)).unwrap(), Some(0));
    // Parent process completion alone does not establish child Job cleanup.
    // Verify kernel accounting before expecting pipe EOF.
    assert_eq!(
        job.terminate_and_wait(Duration::from_secs(3)).unwrap(),
        JobCleanup::Confirmed
    );
    assert_eq!(job.active_processes().unwrap(), 0);
    let mut stdout = String::new();
    let mut stderr = String::new();
    io.stdout.read_to_string(&mut stdout).unwrap();
    io.stderr.read_to_string(&mut stderr).unwrap();
    assert!(stdout.contains("OUT:hello"), "stdout: {stdout:?}");
    assert!(stderr.contains("ERR:hello"), "stderr: {stderr:?}");
}

#[test]
fn restricted_stdio_does_not_inherit_unlisted_agent_handle() {
    use std::io::Read;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};

    // Windows can reuse the same numeric handle value inside the child
    // for a different object. Verify *file identity*, not handle validity.
    let scratch = tempfile::NamedTempFile::new().unwrap();
    let marker_name = scratch
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .replace('\'', "''");
    let handle = scratch.as_raw_handle();
    assert_ne!(
        unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) },
        0
    );
    let script = format!(
        r#"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HandleProbe {{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandleW(
        IntPtr h, System.Text.StringBuilder buffer, uint length, uint flags);
}}
'@
$path = New-Object System.Text.StringBuilder 32768
$n = [HandleProbe]::GetFinalPathNameByHandleW([IntPtr]::new({}), $path, [uint32]$path.Capacity, 0)
if ($n -gt 0 -and $n -lt $path.Capacity -and
    $path.ToString().EndsWith('{}', [StringComparison]::OrdinalIgnoreCase)) {{
    [Console]::Out.WriteLine('LEAKED')
    exit 99
}}
[Console]::Out.WriteLine('ISOLATED')
"#,
        handle as usize, marker_name
    );
    let (job, io) = WindowsJobSession::start_with_stdio(&script).unwrap();
    drop(io.stdin);
    assert_eq!(job.wait_for_exit(Duration::from_secs(15)).unwrap(), Some(0));
    let mut output = String::new();
    io.stdout.take(4096).read_to_string(&mut output).unwrap();
    assert!(
        output.contains("ISOLATED"),
        "handle inheritance check: {output:?}"
    );
    assert_eq!(
        job.terminate_and_wait(Duration::from_secs(3)).unwrap(),
        JobCleanup::Confirmed
    );
}
