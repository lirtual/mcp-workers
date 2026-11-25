//! Opt-in process-level Linux managed-session tests on a disposable host.
#![cfg(target_os = "linux")]

use rca_native_agent::linux_managed::{LinuxManagedSessions, SessionState};
use rca_native_agent::linux_supervisor::CleanupState;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{Duration, Instant};

fn sessions(lifetime: Duration) -> LinuxManagedSessions {
    let helper = std::env::var("RCA_NATIVE_SUPERVISOR_BIN")
        .expect("explicit independently built C supervisor required");
    assert!(Path::new(&helper).is_absolute());
    assert!(Path::new(&helper).is_file());
    LinuxManagedSessions::new(Path::new(&helper), Path::new("/bin/sh"), lifetime).unwrap()
}

fn until_finished(
    registry: &LinuxManagedSessions,
    id: &str,
) -> rca_native_agent::linux_managed::SessionSnapshot {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let snapshot = registry.get(id).expect("owned session retained");
        if snapshot.state != SessionState::Running {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "process lifecycle did not settle"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn assert_not_live(pid: i32) {
    assert!(pid > 0);
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        if unsafe { libc::kill(pid, 0) } != 0 {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            return;
        }
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        let state = stat
            .rsplit_once(") ")
            .and_then(|(_, rest)| rest.split_whitespace().next());
        if matches!(state, Some("Z" | "X")) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "owned child remains running: {stat}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn starts_without_waiting_for_exit_and_exposes_live_output() {
    let registry = sessions(Duration::from_secs(5));
    let start = Instant::now();
    let snapshot = registry
        .start("printf '中😀'; exec 1>&- 2>&-; sleep 1.8; exit 7")
        .unwrap();
    assert!(
        start.elapsed() < Duration::from_millis(1400),
        "start must not wait for command exit"
    );
    assert_eq!(snapshot.state, SessionState::Running);
    let deadline = Instant::now() + Duration::from_millis(1350);
    let mut observed = false;
    while Instant::now() < deadline {
        let output = registry
            .read_output(&snapshot.session_id, 0, 256)
            .unwrap()
            .unwrap();
        if output.page.output == "中😀" && output.session.state == SessionState::Running {
            observed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    assert!(
        observed,
        "bounded output must be readable before process exit"
    );
    let ended = until_finished(&registry, &snapshot.session_id);
    assert_eq!(ended.state, SessionState::Failed);
    assert_eq!(ended.exit_code, Some(7));
    assert_eq!(ended.cleanup, Some(CleanupState::Confirmed));
    assert_eq!(
        registry.stop_all(Duration::from_secs(1)),
        CleanupState::Confirmed
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn deadline_reaps_descendants_and_does_not_fake_success() {
    let registry = sessions(Duration::from_millis(350));
    let started = registry.start("sleep 30 & echo $!; wait").unwrap();
    let ended = until_finished(&registry, &started.session_id);
    assert_eq!(ended.state, SessionState::Failed);
    assert!(ended.deadline_exceeded);
    assert_eq!(ended.cleanup, Some(CleanupState::Confirmed));
    let page = registry
        .read_output(&started.session_id, 0, 256)
        .unwrap()
        .unwrap();
    assert_not_live(page.page.output.trim().parse().unwrap());
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn stop_is_owned_and_revocation_closes_future_admission() {
    let registry = sessions(Duration::from_secs(10));
    let started = registry.start("sleep 30 & echo $!; wait").unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let output = registry
            .read_output(&started.session_id, 0, 256)
            .unwrap()
            .unwrap();
        if !output.page.output.trim().is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "child PID not captured");
        std::thread::sleep(Duration::from_millis(15));
    }
    assert!(registry.request_stop(&started.session_id));
    assert_eq!(
        registry.stop_all(Duration::from_secs(8)),
        CleanupState::Confirmed
    );
    let ended = until_finished(&registry, &started.session_id);
    assert_eq!(ended.state, SessionState::Completed);
    assert_eq!(ended.cleanup, Some(CleanupState::Confirmed));
    let output = registry
        .read_output(&started.session_id, 0, 256)
        .unwrap()
        .unwrap();
    assert_not_live(output.page.output.trim().parse().unwrap());
    assert_eq!(
        registry.start("printf never").err().unwrap().kind(),
        ErrorKind::PermissionDenied
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn kill_escalation_is_unknown_at_session_boundary() {
    let registry = sessions(Duration::from_millis(400));
    let started = registry
        .start("trap '' TERM; sleep 30 & echo $!; wait")
        .unwrap();
    let ended = until_finished(&registry, &started.session_id);
    assert_eq!(ended.state, SessionState::Unknown);
    assert_eq!(ended.cleanup, Some(CleanupState::Unknown));
    assert!(ended.deadline_exceeded);
    let output = registry
        .read_output(&started.session_id, 0, 256)
        .unwrap()
        .unwrap();
    assert_not_live(output.page.output.trim().parse().unwrap());
    assert_eq!(
        registry.stop_all(Duration::from_secs(1)),
        CleanupState::Unknown
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn capacity_uses_live_count_and_reclaims_after_confirmed_exit() {
    let registry = sessions(Duration::from_secs(12));
    let mut ids = Vec::new();
    for _ in 0..10 {
        ids.push(registry.start("sleep 30").unwrap().session_id);
    }
    assert_eq!(
        registry.start("printf overflow").err().unwrap().kind(),
        ErrorKind::WouldBlock
    );
    assert!(registry.request_stop(&ids[0]));
    assert_eq!(
        until_finished(&registry, &ids[0]).state,
        SessionState::Completed
    );
    ids.push(registry.start("sleep 30").unwrap().session_id);
    assert_eq!(
        registry.stop_all(Duration::from_secs(10)),
        CleanupState::Confirmed
    );
    assert!(
        registry.get(&ids[0]).is_none(),
        "oldest completed session pruned at history cap"
    );
    assert!(ids[1..]
        .iter()
        .all(|id| registry.get(id).unwrap().state == SessionState::Completed));
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn invalid_commands_fail_before_launch() {
    let registry = sessions(Duration::from_secs(5));
    for command in ["", "echo \0"] {
        assert_eq!(
            registry.start(command).err().unwrap().kind(),
            ErrorKind::InvalidInput
        );
    }
    assert_eq!(
        registry.start(&"😀".repeat(4097)).err().unwrap().kind(),
        ErrorKind::InvalidInput
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn revocation_is_not_blocked_by_slow_supervisor_startup() {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    let fixture = tempfile::tempdir().unwrap();
    let wrapper = fixture.path().join("delayed-helper");
    let marker = fixture.path().join("started");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf started > '{}'\nsleep 0.6\nexec \"$RCA_NATIVE_SUPERVISOR_BIN\" \"$@\"\n",
            marker.display()
        ),
    ).unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();

    let registry = Arc::new(
        LinuxManagedSessions::new(&wrapper, Path::new("/bin/sh"), Duration::from_secs(5)).unwrap(),
    );
    let background = Arc::clone(&registry);
    let starting = std::thread::spawn(move || background.start("sleep 30"));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !marker.exists() {
        assert!(
            Instant::now() < deadline,
            "supervisor wrapper was not launched"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let stop_started = Instant::now();
    assert_eq!(registry.stop_all(Duration::ZERO), CleanupState::Unknown);
    assert!(
        stop_started.elapsed() < Duration::from_millis(200),
        "revocation waited on startup lock"
    );
    assert!(
        starting.join().unwrap().is_err(),
        "revoked startup must not report success"
    );
    assert_eq!(
        registry.stop_all(Duration::from_secs(5)),
        CleanupState::Confirmed
    );
    assert!(registry
        .list()
        .iter()
        .all(|entry| entry.state != SessionState::Running));
    assert_eq!(
        registry.start("printf never").err().unwrap().kind(),
        ErrorKind::PermissionDenied
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn failed_supervisor_handshake_is_not_missing_from_revocation_accounting() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = tempfile::tempdir().unwrap();
    let wrapper = fixture.path().join("reject-helper");
    std::fs::write(&wrapper, "#!/bin/sh\nexit 125\n").unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();

    let registry =
        LinuxManagedSessions::new(&wrapper, Path::new("/bin/sh"), Duration::from_secs(5)).unwrap();
    assert!(registry.start("printf never").is_err());
    let entries = registry.list();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].state, SessionState::Unknown);
    assert_eq!(entries[0].cleanup, Some(CleanupState::Unknown));
    assert_eq!(registry.stop_all(Duration::ZERO), CleanupState::Unknown);
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn stdin_delivers_unicode_to_owned_shell_and_rejects_invalid_input() {
    use rca_native_agent::linux_managed::InputOutcome;
    let registry = sessions(Duration::from_secs(5));
    let started = registry
        .start("IFS= read -r value; printf '%s' \"$value\"")
        .unwrap();
    assert_eq!(
        registry.write_input(&started.session_id, ""),
        InputOutcome::Failed
    );
    assert_eq!(
        registry.write_input(&started.session_id, "a\0b"),
        InputOutcome::Failed
    );
    assert_eq!(
        registry.write_input(&started.session_id, &"x".repeat(8193)),
        InputOutcome::Failed
    );
    assert_eq!(
        registry.write_input("00000000-0000-4000-8000-000000000000", "text"),
        InputOutcome::NotFound
    );
    assert_eq!(
        registry.write_input(&started.session_id, "中😀\n"),
        InputOutcome::Completed
    );
    let ended = until_finished(&registry, &started.session_id);
    assert_eq!(ended.state, SessionState::Completed);
    let output = registry
        .read_output(&started.session_id, 0, 100)
        .unwrap()
        .unwrap();
    assert_eq!(output.page.output, "中😀");
    assert_eq!(
        registry.write_input(&started.session_id, "late"),
        InputOutcome::Failed
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn stalled_stdin_pipe_returns_unknown_within_one_second() {
    use rca_native_agent::linux_managed::InputOutcome;
    let registry = sessions(Duration::from_secs(5));
    let started = registry.start("sleep 30").unwrap();
    let bytes = "x".repeat(8192);
    let mut backpressured = false;
    for _ in 0..128 {
        let begin = Instant::now();
        match registry.write_input(&started.session_id, &bytes) {
            InputOutcome::Completed => continue,
            InputOutcome::Unknown => {
                assert!(
                    begin.elapsed() < Duration::from_millis(1800),
                    "stdin write exceeded bound"
                );
                backpressured = true;
                break;
            }
            outcome => panic!("unexpected write outcome before backpressure: {outcome:?}"),
        }
    }
    assert!(
        backpressured,
        "unread pipe must eventually apply backpressure"
    );
    assert_eq!(
        registry.stop_all(Duration::from_secs(5)),
        CleanupState::Confirmed
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn contending_stdin_writers_do_not_queue_past_reply_budget() {
    use rca_native_agent::linux_managed::InputOutcome;
    use std::sync::Arc;

    let registry = Arc::new(sessions(Duration::from_secs(6)));
    let started = registry.start("sleep 30").unwrap();
    let bytes = "x".repeat(8192);
    let mut filled = false;
    for _ in 0..128 {
        if registry.write_input(&started.session_id, &bytes) == InputOutcome::Unknown {
            filled = true;
            break;
        }
    }
    assert!(
        filled,
        "unread pipe must backpressure before the concurrency test"
    );

    let first = Arc::clone(&registry);
    let first_id = started.session_id.clone();
    let first_bytes = bytes.clone();
    let writer = std::thread::spawn(move || first.write_input(&first_id, &first_bytes));
    // Let the first writer enter its bounded poll on the full pipe.
    std::thread::sleep(Duration::from_millis(80));
    let begin = Instant::now();
    assert_eq!(
        registry.write_input(&started.session_id, &bytes),
        InputOutcome::Unknown
    );
    assert!(
        begin.elapsed() < Duration::from_millis(400),
        "contending stdin write waited behind another writer"
    );
    assert_eq!(writer.join().unwrap(), InputOutcome::Unknown);
    assert_eq!(
        registry.stop_all(Duration::from_secs(5)),
        CleanupState::Confirmed
    );
}

#[test]
#[ignore = "requires disposable Ubuntu and native C helper"]
fn revoked_session_rejects_new_stdin_effect() {
    use rca_native_agent::linux_managed::InputOutcome;
    let registry = sessions(Duration::from_secs(5));
    let started = registry.start("sleep 30").unwrap();
    assert!(registry.request_stop(&started.session_id));
    assert_eq!(
        registry.write_input(&started.session_id, "not sent"),
        InputOutcome::Failed
    );
    assert_eq!(
        registry.stop_all(Duration::from_secs(5)),
        CleanupState::Confirmed
    );
}
