//! Nonproduction Windows bounded output for a privately owned Job process.
//! Reader threads continuously drain pipes while commands run. After the Job
//! owner has confirmed cleanup, finish() verifies both pipe EOFs within a
//! bounded interval. A blocking or externally inherited pipe is Unknown.
#![cfg(windows)]

use crate::windows_job::WindowsJobIo;
use std::fs::File;
use std::io::{self, ErrorKind, Read};
use std::os::windows::io::AsRawHandle;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::IO::CancelSynchronousIo;

pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
pub const MAX_PAGE_BYTES: usize = 64 * 1024;
const MAX_FINISH_WAIT: Duration = Duration::from_secs(5);

struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
    eof_streams: u8,
    interrupted: bool,
}

#[derive(Clone, Debug)]
pub struct OutputPage {
    pub offset: usize,
    pub next_offset: usize,
    pub output: String,
    pub eof: bool,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputCleanup {
    Confirmed,
    Unknown,
}

pub struct WindowsJobOutput {
    capture: Arc<Mutex<Capture>>,
    workers: Vec<JoinHandle<()>>,
}

fn lock(capture: &Mutex<Capture>) -> std::sync::MutexGuard<'_, Capture> {
    capture.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn append(state: &mut Capture, chunk: &[u8]) {
    if state.truncated {
        return;
    }
    let available = MAX_OUTPUT_BYTES.saturating_sub(state.bytes.len());
    state
        .bytes
        .extend_from_slice(&chunk[..chunk.len().min(available)]);
    if chunk.len() > available {
        // Do not leave a partial UTF-8 character at the fixed byte cap.
        if let Some(mut start) = state.bytes.len().checked_sub(1) {
            while start > 0 && (state.bytes[start] & 0xc0) == 0x80 {
                start -= 1;
            }
            let width = match state.bytes[start] {
                0xf0..=0xf4 => 4,
                0xe0..=0xef => 3,
                0xc2..=0xdf => 2,
                _ => 1,
            };
            if state.bytes.len() - start < width {
                state.bytes.truncate(start);
            }
        }
        state.truncated = true;
    }
}

fn drain(mut stream: File, capture: Arc<Mutex<Capture>>) {
    let mut buffer = [0u8; 8192];
    let eof = loop {
        match stream.read(&mut buffer) {
            Ok(0) => break true,
            Ok(count) => append(&mut lock(&capture), &buffer[..count]),
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break false,
        }
    };
    let mut state = lock(&capture);
    if eof {
        state.eof_streams += 1;
    } else {
        state.interrupted = true;
    }
}

impl WindowsJobOutput {
    /// Consume the child standard streams and return the parent stdin writer.
    /// The Job owner is separate: callers must stop/reap it before finish().
    pub fn attach(io: WindowsJobIo) -> io::Result<(File, Self)> {
        let WindowsJobIo {
            stdin,
            stdout,
            stderr,
        } = io;
        let capture = Arc::new(Mutex::new(Capture {
            bytes: Vec::new(),
            truncated: false,
            eof_streams: 0,
            interrupted: false,
        }));
        let out = Arc::clone(&capture);
        let stdout_worker = thread::Builder::new()
            .name("rca-win-stdout".to_owned())
            .spawn(move || drain(stdout, out))?;
        let err = Arc::clone(&capture);
        let stderr_worker = thread::Builder::new()
            .name("rca-win-stderr".to_owned())
            .spawn(move || drain(stderr, err))?;
        Ok((
            stdin,
            Self {
                capture,
                workers: vec![stdout_worker, stderr_worker],
            },
        ))
    }

    pub fn page(&self, offset: usize, length: usize) -> io::Result<OutputPage> {
        if offset > MAX_OUTPUT_BYTES || !(1..=MAX_PAGE_BYTES).contains(&length) {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "invalid Windows bounded output page",
            ));
        }
        let state = lock(&self.capture);
        let mut start = offset.min(state.bytes.len());
        while start > 0 && start < state.bytes.len() && (state.bytes[start] & 0xc0) == 0x80 {
            start -= 1;
        }
        // The requested offset may fall within a UTF-8 code point. After
        // aligning backward, measure the page budget from that aligned start.
        let mut end = state.bytes.len().min(start.saturating_add(length));
        while end > start && end < state.bytes.len() && (state.bytes[end] & 0xc0) == 0x80 {
            end -= 1;
        }
        if end == start && start < state.bytes.len() {
            end = start + 1;
            while end < state.bytes.len() && (state.bytes[end] & 0xc0) == 0x80 {
                end += 1;
            }
        }
        Ok(OutputPage {
            offset: start,
            next_offset: end,
            output: String::from_utf8_lossy(&state.bytes[start..end]).into_owned(),
            eof: state.eof_streams == 2 && end == state.bytes.len(),
            truncated: state.truncated || state.interrupted,
        })
    }

    /// Called after the Job owner has confirmed its process tree is stopped.
    /// No unbounded join: cancel stuck synchronous reads, then report Unknown
    /// if their threads still cannot be confirmed finished before the limit.
    pub fn finish(&mut self, limit: Duration) -> io::Result<OutputCleanup> {
        if limit.is_zero() || limit > MAX_FINISH_WAIT {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "Windows output settle must be between 1ms and five seconds",
            ));
        }
        let deadline = Instant::now() + limit;
        while self.workers.iter().any(|worker| !worker.is_finished()) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if self.workers.iter().any(|worker| !worker.is_finished()) {
            for worker in &self.workers {
                if !worker.is_finished() {
                    // ERROR_NOT_FOUND means there was no pending synchronous
                    // call to cancel; the final is_finished check is authority.
                    unsafe { CancelSynchronousIo(worker.as_raw_handle()) };
                }
            }
            // At the deadline we must not spend another unbounded grace period.
            return Ok(OutputCleanup::Unknown);
        }
        let mut joined = true;
        for worker in self.workers.drain(..) {
            joined &= worker.join().is_ok();
        }
        let state = lock(&self.capture);
        Ok(if joined && state.eof_streams == 2 && !state.interrupted {
            OutputCleanup::Confirmed
        } else {
            OutputCleanup::Unknown
        })
    }
}

impl Drop for WindowsJobOutput {
    fn drop(&mut self) {
        if !self.workers.is_empty() {
            let _ = self.finish(Duration::from_millis(100));
        }
    }
}
