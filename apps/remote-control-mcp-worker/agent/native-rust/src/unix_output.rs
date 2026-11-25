//! Bounded, continuously drained stdout/stderr for nonproduction Unix
//! managed commands. EOF is verified independently from OS process cleanup.
#![cfg(any(target_os = "linux", target_os = "macos"))]

#[cfg(target_os = "macos")]
use crate::darwin_supervisor::DarwinSupervisorSession as SupervisorSession;
#[cfg(target_os = "linux")]
use crate::linux_supervisor::SupervisorSession;
use std::io::{self, ErrorKind, Read};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
pub const MAX_PAGE_BYTES: usize = 64 * 1024;

struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
    eof_streams: u8,
    interrupted: bool,
}

pub struct OutputPage {
    pub offset: usize,
    pub next_offset: usize,
    pub output: String,
    pub eof: bool,
    pub truncated: bool,
}

/// Two drain threads per live session. Both discard bytes after the cap, but
/// continue reading so a prolific child cannot block on a full OS pipe.
pub struct BoundedProcessOutput {
    capture: Arc<Mutex<Capture>>,
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
}

fn drain<R: Read + AsRawFd + Send + 'static>(
    mut stream: R,
    capture: Arc<Mutex<Capture>>,
    stop: Arc<AtomicBool>,
) {
    let mut bytes = [0u8; 8192];
    let mut at_eof = false;
    while !stop.load(Ordering::Acquire) {
        let mut fd = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut fd, 1, 100) };
        if result == 0 {
            continue;
        }
        if result < 0 {
            if io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        let count = match stream.read(&mut bytes) {
            Ok(0) => {
                at_eof = true;
                break;
            }
            Ok(count) => count,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let mut state = capture.lock().unwrap_or_else(|error| error.into_inner());
        if state.truncated {
            continue;
        }
        let available = MAX_OUTPUT_BYTES.saturating_sub(state.bytes.len());
        state
            .bytes
            .extend_from_slice(&bytes[..count.min(available)]);
        if count > available {
            // A fixed capture boundary can bisect a UTF-8 character.
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
    let mut state = capture.lock().unwrap_or_else(|error| error.into_inner());
    if at_eof {
        state.eof_streams += 1;
    } else {
        state.interrupted = true;
    }
}

impl BoundedProcessOutput {
    pub fn attach(supervisor: &mut SupervisorSession) -> io::Result<Self> {
        let stdout = supervisor
            .take_stdout()
            .ok_or_else(|| io::Error::new(ErrorKind::BrokenPipe, "stdout already taken"))?;
        let stderr = supervisor
            .take_stderr()
            .ok_or_else(|| io::Error::new(ErrorKind::BrokenPipe, "stderr already taken"))?;
        let capture = Arc::new(Mutex::new(Capture {
            bytes: Vec::new(),
            truncated: false,
            eof_streams: 0,
            interrupted: false,
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let workers = vec![
            thread::spawn({
                let capture = Arc::clone(&capture);
                let stop = Arc::clone(&stop);
                move || drain(stdout, capture, stop)
            }),
            thread::spawn({
                let capture = Arc::clone(&capture);
                let stop = Arc::clone(&stop);
                move || drain(stderr, capture, stop)
            }),
        ];
        Ok(Self {
            capture,
            stop,
            workers,
        })
    }

    pub fn page(&self, offset: usize, length: usize) -> io::Result<OutputPage> {
        if offset > MAX_OUTPUT_BYTES || !(1..=MAX_PAGE_BYTES).contains(&length) {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "invalid bounded output page",
            ));
        }
        let state = self
            .capture
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Keep byte offsets, but align returned pages to UTF-8 code points.
        // A 1-byte page over a 4-byte emoji is allowed to advance 4 bytes.
        let mut start = offset.min(state.bytes.len());
        while start > 0 && start < state.bytes.len() && (state.bytes[start] & 0xc0) == 0x80 {
            start -= 1;
        }
        let mut end = state.bytes.len().min(start.max(offset + length));
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

    /// The readers check a 100ms poll timeout, so stop stays bounded even if
    /// an escaped descendant or unrelated process inherited an output pipe.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

impl Drop for BoundedProcessOutput {
    fn drop(&mut self) {
        self.stop();
    }
}
