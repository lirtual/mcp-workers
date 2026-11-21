//! Disposable physical macOS tests for the existing C owned-group helper.
//! The Linux subreaper guarantee is deliberately not asserted on Darwin.
#![cfg(target_os = "macos")]

use rca_native_agent::darwin_supervisor::{DarwinSupervisorSession, GroupCleanup};
use std::io::{BufRead, BufReader, Read};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn helper() -> PathBuf {
    let value = std::env::var_os("RCA_DARWIN_SUPERVISOR_BIN")
        .expect("explicit disposable test-built Darwin helper required");
    let path = PathBuf::from(value);
    assert!(path.is_absolute() && path.is_file());
    path
}

fn sleep_pid(session: &mut DarwinSupervisorSession) -> i32 {
    let stdout = session.take_stdout().expect("owned shell stdout");
    let mut reader = BufReader::new(stdout);
    let mut fd = libc::pollfd {
        fd: reader.get_ref().as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    assert_eq!(unsafe { libc::poll(&mut fd, 1, 3000) }, 1);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let pid: i32 = line.trim().parse().expect("owned child PID");
    assert!(pid > 0);
    pid
}

fn assert_child_stopped(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if unsafe { libc::kill(pid, 0) } != 0 {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            return;
        }
        assert!(
            Instant::now() < deadline,
            "Darwin owned-group descendant remained live"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn refuses_untrusted_helper_or_shell_before_spawning_any_process() {
    assert!(DarwinSupervisorSession::start(
        Path::new("relative-helper"),
        Path::new("/bin/sh"),
        "echo not-run"
    )
    .is_err());
    assert!(DarwinSupervisorSession::start(
        Path::new("/bin/sh"),
        Path::new("/usr/bin/env"),
        "echo not-run"
    )
    .is_err());
}

#[test]
#[ignore = "requires existing C helper built only on a disposable macOS CI runner"]
fn normal_exit_confirms_owned_group_only_and_streams_output() {
    let helper = helper();
    let mut session =
        DarwinSupervisorSession::start(&helper, Path::new("/bin/sh"), "printf rust-darwin-proof")
            .expect("Rust owned-group launch");
    let mut stdout = String::new();
    session
        .take_stdout()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    assert_eq!(stdout, "rust-darwin-proof");
    let outcome = session
        .wait_for_exit(Duration::from_secs(5))
        .unwrap()
        .expect("C monitor observed normal shell exit");
    assert_eq!(outcome.status.code(), Some(0));
    assert_eq!(outcome.group_cleanup, GroupCleanup::OwnedGroupStopped);
}

#[test]
#[ignore = "requires existing C helper built only on a disposable macOS CI runner"]
fn term_stops_only_the_owned_group_without_rust_pid_signals() {
    let helper = helper();
    let mut session =
        DarwinSupervisorSession::start(&helper, Path::new("/bin/sh"), "sleep 30 & echo $!; wait")
            .expect("Rust owned-group launch");
    let pid = sleep_pid(&mut session);
    let outcome = session
        .terminate_and_wait(Duration::from_secs(3))
        .expect("C-owned TERM and group reaping");
    assert!(!outcome.status.success());
    assert_eq!(outcome.group_cleanup, GroupCleanup::OwnedGroupStopped);
    assert_child_stopped(pid);
}

#[test]
#[ignore = "requires existing C helper built only on a disposable macOS CI runner"]
fn lost_owner_control_fails_closed_without_claiming_cleanup() {
    let helper = helper();
    let mut session =
        DarwinSupervisorSession::start(&helper, Path::new("/bin/sh"), "sleep 30 & echo $!; wait")
            .expect("Rust owned-group launch");
    let pid = sleep_pid(&mut session);
    let outcome = session
        .close_control_and_wait(Duration::from_secs(5))
        .expect("C monitor exited after control EOF");
    assert_eq!(outcome.group_cleanup, GroupCleanup::Unknown);
    assert_child_stopped(pid);
}
