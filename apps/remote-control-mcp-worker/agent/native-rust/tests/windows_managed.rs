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
        "$stdin=[Console]::OpenStandardInput();$stdout=[Console]::OpenStandardOutput();$buffer=New-Object byte[] 3;$read=$stdin.Read($buffer,0,3);$stdout.Write($buffer,0,$read);$stdout.Flush()",
    ).unwrap();
    assert_eq!(
        sessions.write_input(&start.session_id, "abc"),
        InputOutcome::Completed
    );
    settle(&sessions, &start.session_id, Duration::from_secs(10));
    let output = sessions
        .read_output(&start.session_id, 0, 128)
        .unwrap()
        .unwrap();
    assert_eq!(output.page.output, "abc");
    assert!(output.page.eof);
    assert_eq!(
        sessions.stop_all(Duration::from_secs(2)),
        JobCleanup::Confirmed
    );
}
