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
use zeroize::Zeroize;

pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
pub const MAX_PAGE_BYTES: usize = 64 * 1024;

struct Capture {
    bytes: Vec<u8>,
    sensitive: bool,
    truncated: bool,
    eof_streams: u8,
    interrupted: bool,
}

pub struct OutputPage {
    pub offset: usize,
    pub next_offset: usize,
    pub output: String,
    pub sensitive: bool,
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
        if state.sensitive || state.truncated {
            bytes[..count].zeroize();
            continue;
        }
        let available = MAX_OUTPUT_BYTES.saturating_sub(state.bytes.len());
        state
            .bytes
            .extend_from_slice(&bytes[..count.min(available)]);
        bytes[..count].zeroize();
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
            sensitive: false,
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

    /// Irreversibly discard captured and future output before writing secure stdin.
    /// Keep draining both pipes so sensitive tasks retain normal lifecycle semantics.
    pub(crate) fn suppress_sensitive(&self) {
        let mut state = self
            .capture
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.sensitive = true;
        state.bytes.zeroize();
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
        if state.sensitive {
            return Ok(OutputPage {
                offset: 0,
                next_offset: 0,
                output: "[output suppressed after secure input was delivered]".into(),
                sensitive: true,
                eof: state.eof_streams == 2,
                truncated: true,
            });
        }
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
            sensitive: false,
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

#[cfg(test)]
mod secure_capture_tests {
    use super::*;

    // #1039 secure capture: preexisting output is removed and no page exposes later output.
    #[test]
    fn secure_input_irreversibly_suppresses_output_pages() {
        let capture = Arc::new(Mutex::new(Capture {
            bytes: b"ordinary-before-input".to_vec(),
            sensitive: false,
            truncated: false,
            eof_streams: 0,
            interrupted: false,
        }));
        let output = BoundedProcessOutput {
            capture: Arc::clone(&capture),
            stop: Arc::new(AtomicBool::new(false)),
            workers: vec![],
        };
        assert_eq!(output.page(0, 64).unwrap().output, "ordinary-before-input");
        output.suppress_sensitive();
        // Drive the real drain through a synthetic pipe-like stream, not just the page filter.
        let (reader, mut writer) = std::os::unix::net::UnixStream::pair().unwrap();
        std::io::Write::write_all(&mut writer, b"synthetic-after-input").unwrap();
        drop(writer);
        drain(
            reader,
            Arc::clone(&capture),
            Arc::new(AtomicBool::new(false)),
        );
        {
            let mut state = capture.lock().unwrap();
            assert!(state.sensitive);
            assert!(state.bytes.is_empty());
            state.eof_streams = 2;
        }
        for offset in [0, 3, MAX_OUTPUT_BYTES] {
            let page = output.page(offset, 64).unwrap();
            assert!(page.sensitive && page.truncated && page.eof);
            assert_eq!(page.next_offset, 0);
            assert_eq!(
                page.output,
                "[output suppressed after secure input was delivered]"
            );
        }
    }
}
