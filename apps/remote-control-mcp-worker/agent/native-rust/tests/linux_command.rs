//! Opt-in real Linux command lifecycle: existing C supervisor, no WSS.
#![cfg(target_os = "linux")]

use rca_native_agent::linux_command::{run_command, CommandEnd};
use rca_native_agent::linux_supervisor::CleanupState;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn helper() -> String {
    let path = std::env::var("RCA_NATIVE_SUPERVISOR_BIN")
        .expect("explicit independently built native supervisor required");
    assert!(Path::new(&path).is_absolute());
    assert!(Path::new(&path).is_file());
    path
}

fn command(
    script: &str,
    limit: Duration,
    stop: &AtomicBool,
) -> rca_native_agent::linux_command::CommandResult {
    run_command(
        Path::new(&helper()),
        Path::new("/bin/sh"),
        script,
        limit,
        stop,
    )
    .unwrap()
}

fn assert_not_live(pid: i32) {
    assert!(pid > 0);
    let deadline = Instant::now() + Duration::from_secs(3);
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
            "supervisor left a live process: {stat}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "requires disposable Linux host and built C supervisor"]
fn normal_exit_reaps_process_and_preserves_bounded_output() {
    let stop = AtomicBool::new(false);
    let result = command(
        "printf '中😀'; printf '%s' stderr >&2; exit 0",
        Duration::from_secs(4),
        &stop,
    );
    assert_eq!(result.end, CommandEnd::Exited(0));
    assert_eq!(result.cleanup, CleanupState::Confirmed);
    assert!(result.output.contains("中😀"));
    assert!(result.output_eof);
    assert!(!result.truncated);
}

#[test]
#[ignore = "requires disposable Linux host and built C supervisor"]
fn pipe_eof_before_process_exit_does_not_create_false_completion() {
    let stop = AtomicBool::new(false);
    let start = Instant::now();
    let result = command(
        "exec 1>&- 2>&-; sleep 0.3; exit 7",
        Duration::from_secs(4),
        &stop,
    );
    assert!(start.elapsed() >= Duration::from_millis(250));
    assert_eq!(result.end, CommandEnd::Exited(7));
    assert_eq!(result.cleanup, CleanupState::Confirmed);
}

#[test]
#[ignore = "requires disposable Linux host and built C supervisor"]
fn deadline_stops_owned_descendants_without_reporting_a_successful_exit() {
    let stop = AtomicBool::new(false);
    let result = command(
        "sleep 30 & echo $!; wait",
        Duration::from_millis(350),
        &stop,
    );
    assert_eq!(result.end, CommandEnd::DeadlineExceeded);
    assert_eq!(result.cleanup, CleanupState::Confirmed);
    let pid: i32 = result
        .output
        .trim()
        .parse()
        .expect("actual spawned child PID");
    assert_not_live(pid);
}

#[test]
#[ignore = "requires disposable Linux host and built C supervisor"]
fn cancellation_reaps_owned_process_and_is_not_a_normal_exit() {
    let stop = Arc::new(AtomicBool::new(false));
    let background = Arc::clone(&stop);
    let thread = std::thread::spawn(move || {
        let result = command(
            "sleep 30 & echo $!; wait",
            Duration::from_secs(5),
            &background,
        );
        (result.end, result.cleanup, result.output)
    });
    std::thread::sleep(Duration::from_millis(400));
    stop.store(true, Ordering::Release);
    let (end, cleanup, output) = thread.join().unwrap();
    assert_eq!(end, CommandEnd::Cancelled);
    assert_eq!(cleanup, CleanupState::Confirmed);
    assert_not_live(output.trim().parse().unwrap());
}

#[test]
#[ignore = "requires disposable Linux host and built C supervisor"]
fn kill_escalation_does_not_claim_confirmed_cleanup() {
    let stop = AtomicBool::new(false);
    let result = command(
        "trap '' TERM; sleep 30 & echo $!; wait",
        Duration::from_millis(400),
        &stop,
    );
    assert_eq!(result.end, CommandEnd::Unknown);
    assert_eq!(result.cleanup, CleanupState::Unknown);
    assert_not_live(result.output.trim().parse().unwrap());
}

#[test]
#[ignore = "requires disposable Linux host and built C supervisor"]
fn already_cancelled_call_never_launches() {
    let stop = AtomicBool::new(true);
    let outcome = run_command(
        Path::new(&helper()),
        Path::new("/bin/sh"),
        "printf never",
        Duration::from_secs(2),
        &stop,
    );
    assert!(outcome.is_err());
}

#[test]
#[ignore = "requires disposable Linux host and built C supervisor"]
fn invalid_commands_are_rejected_before_launch() {
    let stop = AtomicBool::new(false);
    for bad in [
        String::new(),
        format!("echo {}", char::from(0)),
        "x".repeat(8193),
        "😀".repeat(4097),
    ] {
        let result = run_command(
            Path::new(&helper()),
            Path::new("/bin/sh"),
            &bad,
            Duration::from_secs(2),
            &stop,
        );
        assert_eq!(
            result.err().unwrap().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }
    for invalid_lifetime in [Duration::ZERO, Duration::from_secs(3601)] {
        let result = run_command(
            Path::new(&helper()),
            Path::new("/bin/sh"),
            "printf safe",
            invalid_lifetime,
            &stop,
        );
        assert_eq!(
            result.err().unwrap().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }
}
