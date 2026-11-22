//! Opt-in real Linux supervisor protocol: reference C helper, Rust owner.
#![cfg(target_os = "linux")]

use rca_native_agent::linux_supervisor::{CleanupState, SupervisorSession};
use std::io::{BufRead, BufReader};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::time::{Duration, Instant};

fn helper() -> String {
    let path = std::env::var("RCA_NATIVE_SUPERVISOR_BIN")
        .expect("explicit test-built C supervisor path required");
    let path = Path::new(&path);
    assert!(path.is_absolute());
    assert!(path.exists());
    path.to_string_lossy().into_owned()
}

fn spawned_sleep_pid(session: &mut SupervisorSession) -> i32 {
    let stdout = session.take_stdout().expect("supervised shell stdout");
    let mut reader = BufReader::new(stdout);
    let mut fd = libc::pollfd {
        fd: reader.get_ref().as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    assert_eq!(unsafe { libc::poll(&mut fd, 1, 3000) }, 1);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let pid: i32 = line.trim().parse().expect("child sleep PID");
    assert!(pid > 0);
    pid
}

fn assert_no_live_child(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let exists = unsafe { libc::kill(pid, 0) } == 0;
        if !exists {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            break;
        }
        // After group SIGKILL the leader dies too, so a child may briefly be
        // reparented as a non-executing zombie. kill(pid, 0) counts zombies.
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        let state = stat
            .rsplit_once(") ")
            .and_then(|(_, details)| details.split_whitespace().next());
        if matches!(state, Some("Z" | "X")) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "supervisor left a live descendant: {stat}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "requires C helper compiled from the existing repository source on isolated Linux"]
fn rust_signal_control_reaps_an_owned_shell_process_group() {
    let source = helper();
    let mut session = SupervisorSession::start(
        Path::new(&source),
        Path::new("/bin/sh"),
        "sleep 30 & echo $!; wait",
    )
    .expect("Rust launched supervised shell");
    let sleep_pid = spawned_sleep_pid(&mut session);
    let status = session
        .terminate_and_wait(Duration::from_secs(5))
        .expect("SIGTERM/SIGKILL control and reaping");
    assert!(
        !status.status.success(),
        "terminated command must not appear successful"
    );
    assert_eq!(status.cleanup, CleanupState::Confirmed);
    assert_no_live_child(sleep_pid);
}

#[test]
#[ignore = "requires C helper compiled from the existing repository source on isolated Linux"]
fn rust_confirmed_cleanup_reaps_nested_shell_descendants() {
    let source = helper();
    let mut session = SupervisorSession::start(
        Path::new(&source),
        Path::new("/bin/sh"),
        "(sleep 30 & echo $!; wait) & echo $!; (sleep 30 & echo $!; wait) & echo $!; wait",
    )
    .expect("Rust launched supervised shell");

    let stdout = session.take_stdout().expect("supervised shell stdout");
    let mut reader = BufReader::new(stdout);
    let mut pids = Vec::new();
    for _ in 0..4 {
        // BufReader can prefetch several PID lines at once. Poll the fd only
        // when no complete or partial output remains in its userspace buffer.
        if reader.buffer().is_empty() {
            let mut fd = libc::pollfd {
                fd: reader.get_ref().as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            assert_eq!(unsafe { libc::poll(&mut fd, 1, 10_000) }, 1);
        }
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let pid: i32 = line.trim().parse().expect("nested process PID");
        assert!(pid > 1);
        pids.push(pid);
    }
    pids.sort_unstable();
    pids.dedup();
    assert_eq!(
        pids.len(),
        4,
        "fixture must contain two shell levels and two workers"
    );

    let status = session
        .terminate_and_wait(Duration::from_secs(5))
        .expect("SIGTERM/SIGKILL control and descendant reaping");
    assert!(
        !status.status.success(),
        "terminated command must not appear successful"
    );
    assert_eq!(status.cleanup, CleanupState::Confirmed);
    for pid in pids {
        assert_no_live_child(pid);
    }
}

#[test]
#[ignore = "requires C helper compiled from the existing repository source on isolated Linux"]
fn lost_rust_control_pipe_kills_and_reaps_descendants() {
    let source = helper();
    let mut session = SupervisorSession::start(
        Path::new(&source),
        Path::new("/bin/sh"),
        "sleep 30 & echo $!; wait",
    )
    .expect("Rust launched supervised shell");
    let sleep_pid = spawned_sleep_pid(&mut session);
    let exit = session
        .close_control_and_wait(Duration::from_secs(5))
        .expect("control EOF must stop the supervisor");
    assert_eq!(exit.cleanup, CleanupState::Unknown);
    assert_no_live_child(sleep_pid);
}

#[test]
#[ignore = "requires C helper compiled from the existing repository source on isolated Linux"]
fn escalation_is_unknown_when_supervisor_itself_is_killed() {
    let source = helper();
    let mut session = SupervisorSession::start(
        Path::new(&source),
        Path::new("/bin/sh"),
        "trap '' TERM; sleep 30 & echo $!; wait",
    )
    .expect("Rust launched supervised stubborn shell");
    let sleep_pid = spawned_sleep_pid(&mut session);
    let outcome = session
        .terminate_and_wait(Duration::from_millis(150))
        .expect("SIGKILL escalation must reap the process-group leader");
    assert_eq!(outcome.cleanup, CleanupState::Unknown);
    assert_no_live_child(sleep_pid);
}
