//! Native Windows owned-session lifecycle, without a paired RCA identity.
//! These disposable PowerShell commands run only on the Windows CI runner.
#![cfg(windows)]

use rca_native_agent::windows_job::JobCleanup;
use rca_native_agent::windows_managed::{InputOutcome, SessionState, WindowsManagedSessions};
use std::time::{Duration, Instant};

fn settle(registry: &WindowsManagedSessions, id: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let state = registry.get(id).unwrap();
        if state.state != SessionState::Running {
            assert_eq!(state.cleanup, Some(JobCleanup::Confirmed));
            return;
        }
        assert!(
            Instant::now() < deadline,
            "Windows owned session did not settle"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn owned_windows_session_drains_stdout_and_reports_confirmed_eof() {
    let sessions = WindowsManagedSessions::new(Duration::from_secs(10)).unwrap();
    let start = sessions.start(
        "$stream=[Console]::OpenStandardOutput();$bytes=[Text.Encoding]::ASCII.GetBytes('win-ok');$stream.Write($bytes,0,$bytes.Length);$stream.Flush()",
    ).unwrap();
    settle(&sessions, &start.session_id, Duration::from_secs(10));
    let final_state = sessions.get(&start.session_id).unwrap();
    assert_eq!(final_state.state, SessionState::Completed);
    assert_eq!(final_state.exit_code, Some(0));
    let output = sessions
        .read_output(&start.session_id, 0, 128)
        .unwrap()
        .unwrap();
    assert_eq!(output.page.output, "win-ok");
    assert!(output.page.eof);
    assert!(!output.page.truncated);
    assert_eq!(sessions.list().len(), 1);
    assert_eq!(
        sessions.stop_all(Duration::from_secs(2)),
        JobCleanup::Confirmed
    );
}

#[test]
fn revoked_windows_registry_stops_owned_job_and_refuses_new_launch() {
    let sessions = WindowsManagedSessions::new(Duration::from_secs(30)).unwrap();
    let start = sessions.start("Start-Sleep -Seconds 15").unwrap();
    assert_eq!(
        sessions.stop_all(Duration::from_secs(3)),
        JobCleanup::Confirmed
    );
    let final_state = sessions.get(&start.session_id).unwrap();
    assert_eq!(final_state.state, SessionState::Completed);
    assert_eq!(final_state.cleanup, Some(JobCleanup::Confirmed));
    assert!(sessions.start("Write-Output 'no-launch'").is_err());
}

#[test]
fn owned_windows_stdin_round_trip_is_bounded() {
    let sessions = WindowsManagedSessions::new(Duration::from_secs(10)).unwrap();
    let start = sessions.start(
        "$stdin=[Console]::OpenStandardInput();$stdout=[Console]::OpenStandardOutput();$buffer=New-Object byte[] 19;$read=$stdin.Read($buffer,0,19);$stdout.Write($buffer,0,$read);$stdout.Flush()",
    ).unwrap();
    assert_eq!(
        sessions.write_input(&start.session_id, "stdin-roundtrip-914"),
        InputOutcome::Completed
    );
    settle(&sessions, &start.session_id, Duration::from_secs(10));
    let output = sessions
        .read_output(&start.session_id, 0, 8192)
        .unwrap()
        .unwrap();
    // PowerShell may also send CLIXML progress messages through redirected
    // streams. Keep them intact and prove the exact stdin sentinel arrived.
    assert!(output.page.output.contains("stdin-roundtrip-914"));
    assert!(output.page.eof);
    assert_eq!(
        sessions.stop_all(Duration::from_secs(2)),
        JobCleanup::Confirmed
    );
}

#[test]
fn owned_windows_session_id_is_canonical_uuid_v4() {
    let sessions = WindowsManagedSessions::new(Duration::from_secs(10)).unwrap();
    let started = sessions.start("Start-Sleep -Seconds 15").unwrap();
    let id = started.session_id.as_bytes();
    assert_eq!(id.len(), 36);
    for index in [8, 13, 18, 23] {
        assert_eq!(id[index], b'-');
    }
    assert_eq!(id[14], b'4');
    assert!(b"89ab".contains(&id[19]));
    assert!(id.iter().enumerate().all(|(index, byte)| {
        matches!(index, 8 | 13 | 18 | 23) && *byte == b'-'
            || !matches!(index, 8 | 13 | 18 | 23) && byte.is_ascii_hexdigit()
    }));
    assert_eq!(
        sessions.stop_all(Duration::from_secs(3)),
        JobCleanup::Confirmed
    );
}

#[test]
fn secure_stdin_suppresses_echo_and_preserves_unrelated_output() {
    let sessions = WindowsManagedSessions::new(Duration::from_secs(10)).unwrap();
    let target = sessions
        .start("$line=[Console]::ReadLine();if($line -cne 'synthetic-1039-marker'){exit 23};[Console]::Write($line);[Console]::Error.Write($line)")
        .unwrap();
    let other = sessions.start("[Console]::Write('unrelated')").unwrap();
    assert_eq!(
        sessions.write_secure_input(&target.session_id, "synthetic-1039-marker\n"),
        InputOutcome::Completed
    );
    settle(&sessions, &target.session_id, Duration::from_secs(10));
    assert_eq!(sessions.get(&target.session_id).unwrap().exit_code, Some(0));
    settle(&sessions, &other.session_id, Duration::from_secs(10));
    let page = sessions
        .read_output(&target.session_id, 0, 1024)
        .unwrap()
        .unwrap()
        .page;
    assert!(page.sensitive);
    assert_eq!(
        page.output,
        "[output suppressed after secure input was delivered]"
    );
    let unrelated = sessions
        .read_output(&other.session_id, 0, 1024)
        .unwrap()
        .unwrap()
        .page;
    assert!(!unrelated.sensitive);
    assert_eq!(unrelated.output, "unrelated");
    assert_eq!(
        sessions.write_secure_input(&target.session_id, "not delivered"),
        InputOutcome::Failed
    );
}
