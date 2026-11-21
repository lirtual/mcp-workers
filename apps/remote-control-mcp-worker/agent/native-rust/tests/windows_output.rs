//! Bounded native stdout/stderr proof on the physical Windows CI runner.
//! Uses only disposable PowerShell Job processes, never real RCA identities.
#![cfg(windows)]

use rca_native_agent::windows_job::{JobCleanup, WindowsJobSession};
use rca_native_agent::windows_output::{
    OutputCleanup, WindowsJobOutput, MAX_OUTPUT_BYTES, MAX_PAGE_BYTES,
};
use std::time::{Duration, Instant};

fn confirmed_exit(job: &WindowsJobSession) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match job.wait_for_exit(Duration::from_millis(20)).unwrap() {
            Some(code) => {
                assert_eq!(code, 0, "PowerShell command failed");
                break;
            }
            None => assert!(Instant::now() < deadline, "owned command did not finish"),
        }
    }
    assert_eq!(
        job.terminate_and_wait(Duration::from_secs(5)).unwrap(),
        JobCleanup::Confirmed
    );
}

#[test]
fn output_is_drained_while_running_and_caps_at_256_kib() {
    let (job, pipes) = WindowsJobSession::start_with_stdio(
        "$stream=[Console]::OpenStandardOutput();$bytes=[Text.Encoding]::ASCII.GetBytes('A'*300000);$stream.Write($bytes,0,$bytes.Length);$stream.Flush()",
    )
    .unwrap();
    let (stdin, mut output) = WindowsJobOutput::attach(pipes).unwrap();
    drop(stdin);
    confirmed_exit(&job);
    assert_eq!(
        output.finish(Duration::from_secs(3)).unwrap(),
        OutputCleanup::Confirmed
    );
    let first = output.page(0, MAX_PAGE_BYTES).unwrap();
    assert_eq!(first.output.len(), MAX_PAGE_BYTES);
    assert!(first.output.bytes().all(|b| b == b'A'));
    assert!(first.truncated);
    assert!(!first.eof);
    let last = output.page(MAX_OUTPUT_BYTES - 1, 1).unwrap();
    assert_eq!(last.output, "A");
    assert_eq!(last.next_offset, MAX_OUTPUT_BYTES);
    assert!(last.eof);
    assert!(last.truncated);
}

#[test]
fn utf8_pages_align_to_code_points_and_preserve_eof() {
    let (job, pipes) = WindowsJobSession::start_with_stdio(
        "$stream=[Console]::OpenStandardOutput();$bytes=[Text.Encoding]::UTF8.GetBytes('中😀B');$stream.Write($bytes,0,$bytes.Length);$stream.Flush()",
    )
    .unwrap();
    let (stdin, mut output) = WindowsJobOutput::attach(pipes).unwrap();
    drop(stdin);
    confirmed_exit(&job);
    assert_eq!(
        output.finish(Duration::from_secs(3)).unwrap(),
        OutputCleanup::Confirmed
    );
    let first = output.page(0, 1).unwrap();
    assert_eq!(first.output, "中");
    assert_eq!(first.next_offset, 3);
    let second = output.page(3, 1).unwrap();
    assert_eq!(second.output, "😀");
    assert_eq!(second.next_offset, 7);
    let last = output.page(7, 1).unwrap();
    assert_eq!(last.output, "B");
    assert_eq!(last.next_offset, 8);
    assert!(last.eof);
    assert!(!last.truncated);
    assert!(output.page(MAX_OUTPUT_BYTES + 1, 1).is_err());
    assert!(output.page(0, MAX_PAGE_BYTES + 1).is_err());
}

#[test]
fn unaligned_utf8_offset_cannot_exceed_maximum_page_budget() {
    let (job, pipes) = WindowsJobSession::start_with_stdio(
        "$stream=[Console]::OpenStandardOutput();$prefix=[Text.Encoding]::UTF8.GetBytes('中');$tail=[Text.Encoding]::ASCII.GetBytes('A'*70000);$stream.Write($prefix,0,$prefix.Length);$stream.Write($tail,0,$tail.Length);$stream.Flush()",
    )
    .unwrap();
    let (stdin, mut output) = WindowsJobOutput::attach(pipes).unwrap();
    drop(stdin);
    confirmed_exit(&job);
    assert_eq!(
        output.finish(Duration::from_secs(3)).unwrap(),
        OutputCleanup::Confirmed
    );
    let first = output.page(1, MAX_PAGE_BYTES).unwrap();
    assert_eq!(first.offset, 0);
    assert_eq!(first.next_offset, MAX_PAGE_BYTES);
    assert_eq!(first.output.len(), MAX_PAGE_BYTES);
    assert!(first.output.starts_with('中'));
    assert!(!first.eof);
    let last = output.page(first.next_offset, MAX_PAGE_BYTES).unwrap();
    assert_eq!(last.output.len(), 70003 - MAX_PAGE_BYTES);
    assert!(last.eof);
}

#[test]
fn live_writer_never_reports_confirmed_output_cleanup() {
    let (job, pipes) = WindowsJobSession::start_with_stdio("Start-Sleep -Seconds 10").unwrap();
    let (stdin, mut output) = WindowsJobOutput::attach(pipes).unwrap();
    drop(stdin);
    assert_eq!(
        output.finish(Duration::from_millis(30)).unwrap(),
        OutputCleanup::Unknown
    );
    assert_eq!(
        job.terminate_and_wait(Duration::from_secs(5)).unwrap(),
        JobCleanup::Confirmed
    );
}
