//! Nonproduction Windows managed sessions backed by one private Job per command.
//! The signed transport and SQLite receipt owner remain outside this registry.
//! No PID from a remote request can select a process to terminate.
#![cfg(windows)]

use crate::windows_job::{self, JobCleanup, WindowsJobSession};
use crate::windows_output::{OutputCleanup, OutputPage, WindowsJobOutput};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, ErrorKind, Write};
use std::os::windows::io::AsRawHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::SYSTEMTIME;
use windows_sys::Win32::System::SystemInformation::GetSystemTime;
use windows_sys::Win32::System::IO::CancelSynchronousIo;

const MAX_SESSIONS: usize = 10;
const MAX_HISTORY: usize = 10;
const HISTORY_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_LIFETIME: Duration = Duration::from_secs(60 * 60);
const POLL: Duration = Duration::from_millis(50);
const STOP_GRACE: Duration = Duration::from_millis(800);
const OUTPUT_GRACE: Duration = Duration::from_millis(700);
const INPUT_WRITE_LIMIT: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub(crate) struct SessionCapacityReached;

impl std::fmt::Display for SessionCapacityReached {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("session capacity reached")
    }
}

impl std::error::Error for SessionCapacityReached {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Running,
    Completed,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputOutcome {
    Completed,
    Failed,
    Unknown,
    NotFound,
}

#[derive(Clone, Debug)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub started_at: String,
    pub last_observed_at: String,
    pub state: SessionState,
    pub exit_code: Option<i32>,
    pub cleanup: Option<JobCleanup>,
    pub deadline_exceeded: bool,
}

pub struct SessionOutput {
    pub session: SessionSnapshot,
    pub page: OutputPage,
}

struct Record {
    state: SessionState,
    exit_code: Option<i32>,
    cleanup: Option<JobCleanup>,
    deadline_exceeded: bool,
    finished_at: Option<Instant>,
}

struct Entry {
    started_at: String,
    record: Mutex<Record>,
    output: Mutex<Option<WindowsJobOutput>>,
    stdin: Mutex<Option<File>>,
    input_busy: AtomicBool,
    stop: AtomicBool,
}

struct Registry {
    closed: bool,
    entries: HashMap<String, Arc<Entry>>,
}

/// Unknown process or pipe cleanup continues to occupy capacity. Never
/// silently replace an uncertain command with another process.
pub struct WindowsManagedSessions {
    lifetime: Duration,
    inner: Mutex<Registry>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn session_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| io::Error::other("Windows session ID entropy unavailable"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15]
    ))
}

fn utc_clock() -> String {
    let mut now = SYSTEMTIME::default();
    unsafe { GetSystemTime(&mut now) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds
    )
}

fn snapshot(id: &str, entry: &Entry) -> SessionSnapshot {
    let record = lock(&entry.record);
    SessionSnapshot {
        session_id: id.to_owned(),
        started_at: entry.started_at.clone(),
        last_observed_at: utc_clock(),
        state: record.state,
        exit_code: record.exit_code,
        cleanup: record.cleanup,
        deadline_exceeded: record.deadline_exceeded,
    }
}

fn mark_uncertain(entry: &Entry) {
    let mut state = lock(&entry.record);
    state.state = SessionState::Unknown;
    state.cleanup = Some(JobCleanup::Unknown);
    state.finished_at = Some(Instant::now());
}

fn supervise(job: WindowsJobSession, entry: Arc<Entry>, deadline: Instant) {
    let (stopped, expired, exit_code): (bool, bool, io::Result<Option<u32>>) = loop {
        match job.wait_for_exit(Duration::ZERO) {
            Ok(Some(exit)) => break (false, false, Ok(Some(exit))),
            Err(error) => break (false, false, Err(error)),
            Ok(None) => (),
        }
        if entry.stop.load(Ordering::Acquire) {
            break (true, false, Ok(None));
        }
        if Instant::now() >= deadline {
            break (false, true, Ok(None));
        }
        let interval = POLL.min(deadline.saturating_duration_since(Instant::now()));
        match job.wait_for_exit(interval) {
            Ok(Some(exit)) => break (false, false, Ok(Some(exit))),
            Ok(None) => (),
            Err(error) => break (false, false, Err(error)),
        }
    };
    // Even when PowerShell exits normally, its owned children may remain.
    // Kernel Job accounting is the authority, not exit code or pipe EOF.
    let job_cleanup = job
        .terminate_and_wait(STOP_GRACE)
        .unwrap_or(JobCleanup::Unknown);
    lock(&entry.stdin).take();
    let output_cleanup = match lock(&entry.output).as_mut() {
        Some(output) => output
            .finish(OUTPUT_GRACE)
            .unwrap_or(OutputCleanup::Unknown),
        None => OutputCleanup::Unknown,
    };
    let mut state = lock(&entry.record);
    state.finished_at = Some(Instant::now());
    state.deadline_exceeded = expired;
    state.cleanup = Some(
        if job_cleanup == JobCleanup::Confirmed && output_cleanup == OutputCleanup::Confirmed {
            JobCleanup::Confirmed
        } else {
            JobCleanup::Unknown
        },
    );
    match exit_code {
        Ok(code) => {
            state.exit_code = code.map(|code| code as i32);
            state.state = if state.cleanup != Some(JobCleanup::Confirmed) {
                SessionState::Unknown
            } else if expired {
                SessionState::Failed
            } else if stopped || code == Some(0) {
                SessionState::Completed
            } else {
                SessionState::Failed
            };
        }
        Err(_) => state.state = SessionState::Unknown,
    }
}

impl WindowsManagedSessions {
    pub fn new(lifetime: Duration) -> io::Result<Self> {
        if lifetime.is_zero() || lifetime > MAX_LIFETIME {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "invalid Windows session lifetime",
            ));
        }
        Ok(Self {
            lifetime,
            inner: Mutex::new(Registry {
                closed: false,
                entries: HashMap::new(),
            }),
        })
    }

    fn prune(registry: &mut Registry) {
        let now = Instant::now();
        registry.entries.retain(|_, entry| {
            let state = lock(&entry.record);
            matches!(state.state, SessionState::Running | SessionState::Unknown)
                || state
                    .finished_at
                    .is_none_or(|at| now.duration_since(at) < HISTORY_TTL)
        });
        let mut history: Vec<_> = registry
            .entries
            .iter()
            .filter_map(|(id, entry)| {
                let state = lock(&entry.record);
                if matches!(state.state, SessionState::Completed | SessionState::Failed) {
                    state.finished_at.map(|at| (id.clone(), at))
                } else {
                    None
                }
            })
            .collect();
        history.sort_by_key(|(_, at)| *at);
        let excess = history.len().saturating_sub(MAX_HISTORY);
        for (id, _) in history.into_iter().take(excess) {
            registry.entries.remove(&id);
        }
    }

    pub fn start(&self, command: &str) -> io::Result<SessionSnapshot> {
        if !windows_job::valid_command_text(command) {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "invalid command text",
            ));
        }
        let id = session_id()?;
        let entry = Arc::new(Entry {
            started_at: utc_clock(),
            record: Mutex::new(Record {
                state: SessionState::Running,
                exit_code: None,
                cleanup: None,
                deadline_exceeded: false,
                finished_at: None,
            }),
            output: Mutex::new(None),
            stdin: Mutex::new(None),
            input_busy: AtomicBool::new(false),
            stop: AtomicBool::new(false),
        });
        {
            let mut registry = lock(&self.inner);
            Self::prune(&mut registry);
            if registry.closed {
                return Err(io::Error::new(
                    ErrorKind::PermissionDenied,
                    "sessions closed",
                ));
            }
            let active = registry
                .entries
                .values()
                .filter(|entry| {
                    matches!(
                        lock(&entry.record).state,
                        SessionState::Running | SessionState::Unknown
                    )
                })
                .count();
            if active >= MAX_SESSIONS {
                return Err(io::Error::new(
                    ErrorKind::WouldBlock,
                    SessionCapacityReached,
                ));
            }
            registry.entries.insert(id.clone(), Arc::clone(&entry));
        }
        if entry.stop.load(Ordering::Acquire) {
            let mut state = lock(&entry.record);
            state.state = SessionState::Failed;
            state.cleanup = Some(JobCleanup::Confirmed);
            state.finished_at = Some(Instant::now());
            return Err(io::Error::new(
                ErrorKind::Interrupted,
                "session revoked before launch",
            ));
        }

        let started = Instant::now();
        let (job, pipes) = match WindowsJobSession::start_with_stdio(command) {
            Ok(pair) => pair,
            Err(error) => {
                // Start may have reached OS process creation. Its Job handle
                // drop is best effort, not independent cleanup proof.
                mark_uncertain(&entry);
                return Err(error);
            }
        };
        let (stdin, output) = match WindowsJobOutput::attach(pipes) {
            Ok(pair) => pair,
            Err(error) => {
                drop(job);
                mark_uncertain(&entry);
                return Err(error);
            }
        };
        *lock(&entry.stdin) = Some(stdin);
        *lock(&entry.output) = Some(output);
        let worker = Arc::clone(&entry);
        let deadline = started + self.lifetime;
        if let Err(error) = thread::Builder::new()
            .name("rca-owned-windows-session".to_owned())
            .spawn(move || supervise(job, worker, deadline))
        {
            mark_uncertain(&entry);
            return Err(error);
        }
        if entry.stop.load(Ordering::Acquire) {
            return Err(io::Error::new(
                ErrorKind::Interrupted,
                "session revoked during launch",
            ));
        }
        Ok(snapshot(&id, &entry))
    }

    pub fn get(&self, id: &str) -> Option<SessionSnapshot> {
        let mut registry = lock(&self.inner);
        Self::prune(&mut registry);
        registry.entries.get(id).map(|entry| snapshot(id, entry))
    }

    pub fn list(&self) -> Vec<SessionSnapshot> {
        let mut registry = lock(&self.inner);
        Self::prune(&mut registry);
        registry
            .entries
            .iter()
            .map(|(id, entry)| snapshot(id, entry))
            .collect()
    }

    pub fn read_output(
        &self,
        id: &str,
        offset: usize,
        length: usize,
    ) -> io::Result<Option<SessionOutput>> {
        let entry = {
            let mut registry = lock(&self.inner);
            Self::prune(&mut registry);
            registry.entries.get(id).cloned()
        };
        match entry {
            None => Ok(None),
            Some(entry) => {
                let page = lock(&entry.output)
                    .as_ref()
                    .ok_or_else(|| io::Error::new(ErrorKind::WouldBlock, "session still starting"))?
                    .page(offset, length)?;
                Ok(Some(SessionOutput {
                    session: snapshot(id, &entry),
                    page,
                }))
            }
        }
    }

    /// Each input action receives its own durable SQLite receipt before this
    /// function is called. A timeout or partial pipe write always means Unknown.
    pub fn write_input(&self, id: &str, input: &str) -> InputOutcome {
        if input.is_empty() || input.len() > 8192 || input.contains(char::from(0)) {
            return InputOutcome::Failed;
        }
        let entry = {
            let mut registry = lock(&self.inner);
            Self::prune(&mut registry);
            registry.entries.get(id).cloned()
        };
        let Some(entry) = entry else {
            return InputOutcome::NotFound;
        };
        if entry.stop.load(Ordering::Acquire) || lock(&entry.record).state != SessionState::Running
        {
            return InputOutcome::Failed;
        }
        if entry.input_busy.swap(true, Ordering::AcqRel) {
            return InputOutcome::Unknown;
        }
        let pipe = lock(&entry.stdin).as_ref().map(File::try_clone);
        let Some(Ok(mut stdin)) = pipe else {
            entry.input_busy.store(false, Ordering::Release);
            return InputOutcome::Unknown;
        };
        let bytes = input.as_bytes().to_vec();
        let writing = Arc::clone(&entry);
        let (sender, receiver) = sync_channel(1);
        let worker = match thread::Builder::new()
            .name("rca-win-stdin-write".to_owned())
            .spawn(move || {
                let result = stdin.write_all(&bytes);
                writing.input_busy.store(false, Ordering::Release);
                let _ = sender.send(result);
            }) {
            Ok(worker) => worker,
            Err(_) => {
                entry.input_busy.store(false, Ordering::Release);
                return InputOutcome::Unknown;
            }
        };
        let outcome = match receiver.recv_timeout(INPUT_WRITE_LIMIT) {
            Ok(Ok(())) if !entry.stop.load(Ordering::Acquire) => InputOutcome::Completed,
            Ok(Err(_)) | Ok(Ok(())) | Err(RecvTimeoutError::Disconnected) => InputOutcome::Unknown,
            Err(RecvTimeoutError::Timeout) => {
                unsafe { CancelSynchronousIo(worker.as_raw_handle()) };
                InputOutcome::Unknown
            }
        };
        // Dropping the thread handle never joins an unbounded blocked writer.
        drop(worker);
        outcome
    }

    pub fn request_stop(&self, id: &str) -> bool {
        let registry = lock(&self.inner);
        match registry.entries.get(id) {
            Some(entry) => {
                entry.stop.store(true, Ordering::Release);
                true
            }
            None => false,
        }
    }

    /// Close admission before signaling processes, and only confirm actual
    /// Job-plus-pipe cleanup. Never free Unknown sessions as ordinary history.
    pub fn stop_all(&self, wait: Duration) -> JobCleanup {
        let entries: Vec<_> = {
            let mut registry = lock(&self.inner);
            registry.closed = true;
            let entries = registry.entries.values().cloned().collect::<Vec<_>>();
            for entry in &entries {
                entry.stop.store(true, Ordering::Release);
            }
            entries
        };
        let deadline = Instant::now() + wait;
        loop {
            let mut all_finished = true;
            let mut confirmed = true;
            for entry in &entries {
                let record = lock(&entry.record);
                if record.state == SessionState::Running {
                    all_finished = false;
                } else if record.cleanup != Some(JobCleanup::Confirmed) {
                    confirmed = false;
                }
            }
            if all_finished {
                return if confirmed {
                    JobCleanup::Confirmed
                } else {
                    JobCleanup::Unknown
                };
            }
            if Instant::now() >= deadline {
                return JobCleanup::Unknown;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for WindowsManagedSessions {
    fn drop(&mut self) {
        let registry = lock(&self.inner);
        for entry in registry.entries.values() {
            entry.stop.store(true, Ordering::Release);
        }
    }
}
