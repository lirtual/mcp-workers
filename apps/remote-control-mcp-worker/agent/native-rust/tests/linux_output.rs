//! Real Linux process output: opt-in, disposable C helper only.
#![cfg(target_os = "linux")]

use rca_native_agent::linux_output::{BoundedProcessOutput, MAX_OUTPUT_BYTES, MAX_PAGE_BYTES};
use rca_native_agent::linux_supervisor::{CleanupState, SupervisorSession};
use std::path::Path;
use std::time::{Duration, Instant};

fn helper() -> String {
    let path =
        std::env::var("RCA_NATIVE_SUPERVISOR_BIN").expect("explicit test-built C helper required");
    assert!(Path::new(&path).is_absolute());
    path
}

#[test]
#[ignore = "requires independently built C helper on disposable Linux"]
fn large_stdout_and_stderr_are_drained_without_process_deadlock() {
    let helper = helper();
    let mut process = SupervisorSession::start(
        Path::new(&helper),
        Path::new("/bin/sh"),
        "yes x | head -c 450000; yes y | head -c 450000 >&2",
    )
    .expect("managed process");
    let mut output = BoundedProcessOutput::attach(&mut process).unwrap();
    let exit = process
        .wait_for_exit(Duration::from_secs(5))
        .expect("supervisor wait")
        .expect("high-volume command must not stall on output pipes");
    assert!(exit.status.success());
    assert_eq!(exit.cleanup, CleanupState::Confirmed);

    let deadline = Instant::now() + Duration::from_secs(3);
    let mut total = 0usize;
    let mut truncated = false;
    loop {
        let page = output.page(total, MAX_PAGE_BYTES).unwrap();
        assert_eq!(page.offset, total);
        total = page.next_offset;
        truncated |= page.truncated;
        if page.eof {
            break;
        }
        assert!(Instant::now() < deadline, "output never reached EOF");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(total, MAX_OUTPUT_BYTES);
    assert!(truncated, "all output above 256KiB must be discarded");
    assert!(output.page(0, 0).is_err());
    assert!(output.page(MAX_OUTPUT_BYTES + 1, 1).is_err());
    output.stop();
}

#[test]
#[ignore = "requires independently built C helper on disposable Linux"]
fn stopping_readers_never_waits_for_child_pipe_eof() {
    let helper = helper();
    let mut process =
        SupervisorSession::start(Path::new(&helper), Path::new("/bin/sh"), "sleep 30")
            .expect("managed process");
    let mut output = BoundedProcessOutput::attach(&mut process).unwrap();
    let start = Instant::now();
    output.stop();
    assert!(start.elapsed() < Duration::from_secs(2));
    let page = output.page(0, 1).unwrap();
    assert!(
        !page.eof,
        "stopped readers have not independently observed EOF"
    );
    assert!(
        page.truncated,
        "early reader stop must disclose incomplete capture"
    );
    let exit = process.terminate_and_wait(Duration::from_secs(5)).unwrap();
    assert_eq!(exit.cleanup, CleanupState::Confirmed);
}

#[test]
#[ignore = "requires independently built C helper on disposable Linux"]
fn utf8_pages_match_existing_node_byte_boundary_contract() {
    let helper = helper();
    let mut process =
        SupervisorSession::start(Path::new(&helper), Path::new("/bin/sh"), "printf '中😀A'")
            .unwrap();
    let mut output = BoundedProcessOutput::attach(&mut process).unwrap();
    let exit = process
        .wait_for_exit(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert!(exit.status.success());
    let deadline = Instant::now() + Duration::from_secs(3);
    while !output.page(0, MAX_PAGE_BYTES).unwrap().eof {
        assert!(Instant::now() < deadline, "output streams did not close");
        std::thread::sleep(Duration::from_millis(10));
    }
    let chinese = output.page(1, 1).unwrap();
    assert_eq!(chinese.offset, 0);
    assert_eq!(chinese.next_offset, 3);
    assert_eq!(chinese.output, "中");
    let emoji = output.page(4, 1).unwrap();
    assert_eq!(emoji.offset, 3);
    assert_eq!(emoji.next_offset, 7);
    assert_eq!(emoji.output, "😀");
    let last = output.page(7, 1).unwrap();
    assert_eq!(last.output, "A");
    assert_eq!(last.next_offset, 8);
    output.stop();
}

#[test]
#[ignore = "requires independently built C helper on disposable Linux"]
fn byte_cap_drops_incomplete_utf8_tail_before_marking_truncated() {
    let helper = helper();
    let mut process = SupervisorSession::start(
        Path::new(&helper),
        Path::new("/bin/sh"),
        "head -c 262143 /dev/zero | tr '\\000' a; printf '中'; printf x",
    )
    .unwrap();
    let mut output = BoundedProcessOutput::attach(&mut process).unwrap();
    let exit = process
        .wait_for_exit(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert!(exit.status.success());
    let deadline = Instant::now() + Duration::from_secs(3);
    let last = loop {
        let page = output.page(MAX_OUTPUT_BYTES - 10, MAX_PAGE_BYTES).unwrap();
        if page.eof {
            break page;
        }
        assert!(Instant::now() < deadline, "output streams did not close");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(last.next_offset, MAX_OUTPUT_BYTES - 1);
    assert_eq!(last.output, "a".repeat(9));
    assert!(last.truncated);
    output.stop();
}
