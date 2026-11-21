//! Nonproduction Linux managed-session registry. It is deliberately not a WSS
//! executor: durable receipt admission and Owner authorization must precede
//! any future dispatch into this registry.
#![cfg(target_os = "linux")]

use crate::linux_output::{BoundedProcessOutput, OutputPage};
use crate::linux_supervisor::{CleanupState, SupervisorExit, SupervisorSession};
use std::collections::HashMap;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_SESSIONS: usize = 10;
const MAX_HISTORY: usize = 10;
const HISTORY_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_LIFETIME: Duration = Duration::from_secs(60 * 60);
const POLL: Duration = Duration::from_millis(50);
const STOP_GRACE: Duration = Duration::from_millis(500);
const DEADLINE_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Running,
    Completed,
    Failed,
    Unknown,
}

#[derive(Clone, Debug)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub state: SessionState,
    pub exit_code: Option<i32>,
    pub cleanup: Option<CleanupState>,
    pub deadline_exceeded: bool,
}

pub struct SessionOutput {
    pub session: SessionSnapshot,
    pub page: OutputPage,
}

struct Record {
    state: SessionState,
    exit_code: Option<i32>,
    cleanup: Option<CleanupState>,
    deadline_exceeded: bool,
    finished_at: Option<Instant>,
}

#[derive(Clone)]
struct Entry {
    record: Arc<Mutex<Record>>,
    output: Arc<Mutex<BoundedProcessOutput>>,
    stop: Arc<AtomicBool>,
}

struct Registry {
    closed: bool,
    entries: HashMap<String, Entry>,
}

/// At most ten owned live/uncertain Linux commands. Completed history is
/// bounded independently, and an unknown cleanup never frees active capacity.
pub struct LinuxManagedSessions {
    helper: PathBuf,
    shell: PathBuf,
    lifetime: Duration,
    inner: Mutex<Registry>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn valid_command(command: &str) -> bool {
    !command.is_empty()
        && !command.contains('\0')
        && command.encode_utf16().take(8193).count() <= 8192
}

fn new_session_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
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

fn snapshot(id: &str, entry: &Entry) -> SessionSnapshot {
    let state = lock(&entry.record);
    SessionSnapshot {
        session_id: id.to_owned(),
        state: state.state,
        exit_code: state.exit_code,
        cleanup: state.cleanup,
        deadline_exceeded: state.deadline_exceeded,
    }
}

fn supervise(mut supervisor: SupervisorSession, entry: Entry, deadline: Instant) {
    let (stopped, expired, outcome): (bool, bool, io::Result<SupervisorExit>) = loop {
        // Reconcile an already-reaped command before applying a later stop or
        // deadline; output-pipe EOF alone is never this evidence.
        match supervisor.wait_for_exit(Duration::ZERO) {
            Ok(Some(exited)) => break (false, false, Ok(exited)),
            Err(error) => break (false, false, Err(error)),
            Ok(None) => (),
        }
        if entry.stop.load(Ordering::Acquire) {
            break (true, false, supervisor.terminate_and_wait(STOP_GRACE));
        }
        if Instant::now() >= deadline {
            break (false, true, supervisor.terminate_and_wait(DEADLINE_GRACE));
        }
        let interval = POLL.min(deadline.saturating_duration_since(Instant::now()));
        match supervisor.wait_for_exit(interval) {
            Ok(Some(exited)) => break (false, false, Ok(exited)),
            Ok(None) => (),
            Err(error) => break (false, false, Err(error)),
        }
    };

    // The reader threads must be stopped before a finished snapshot is visible.
    // Inherited pipe FDs may outlive the supervised process; output EOF alone
    // never marks a process completed.
    lock(&entry.output).stop();
    let mut state = lock(&entry.record);
    state.deadline_exceeded = expired;
    state.finished_at = Some(Instant::now());
    match outcome {
        Ok(exit) => {
            state.exit_code = exit.status.code();
            state.cleanup = Some(exit.cleanup);
            state.state = if exit.cleanup == CleanupState::Unknown {
                SessionState::Unknown
            } else if expired {
                SessionState::Failed
            } else if stopped || exit.status.success() {
                SessionState::Completed
            } else {
                SessionState::Failed
            };
        }
        Err(_) => {
            state.state = SessionState::Unknown;
            state.cleanup = Some(CleanupState::Unknown);
        }
    }
}

impl LinuxManagedSessions {
    pub fn new(helper: &Path, shell: &Path, lifetime: Duration) -> io::Result<Self> {
        if !helper.is_absolute()
            || !shell.is_absolute()
            || lifetime.is_zero()
            || lifetime > MAX_LIFETIME
        {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "invalid native session configuration",
            ));
        }
        Ok(Self {
            helper: helper.to_owned(),
            shell: shell.to_owned(),
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
            state.state == SessionState::Running
                || state.state == SessionState::Unknown
                || state
                    .finished_at
                    .is_none_or(|ended| now.duration_since(ended) < HISTORY_TTL)
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

    /// Launch a command using the already-audited native supervisor. Returns
    /// after the helper readiness handshake, without waiting for process exit.
    /// The registry lock serializes startup with revocation and capacity checks.
    pub fn start(&self, command: &str) -> io::Result<SessionSnapshot> {
        if !valid_command(command) {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "invalid command text",
            ));
        }
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
                "session capacity reached",
            ));
        }

        let id = new_session_id()?;
        let spawned_at = Instant::now();
        let mut supervisor = SupervisorSession::start(&self.helper, &self.shell, command)?;
        let output = Arc::new(Mutex::new(BoundedProcessOutput::attach(&mut supervisor)?));
        let entry = Entry {
            record: Arc::new(Mutex::new(Record {
                state: SessionState::Running,
                exit_code: None,
                cleanup: None,
                deadline_exceeded: false,
                finished_at: None,
            })),
            output,
            stop: Arc::new(AtomicBool::new(false)),
        };
        let response = snapshot(&id, &entry);
        let worker = entry.clone();
        let deadline = spawned_at + self.lifetime;
        thread::Builder::new()
            .name("rca-owned-linux-session".to_owned())
            .spawn(move || supervise(supervisor, worker, deadline))?;
        registry.entries.insert(id, entry);
        Ok(response)
    }

    pub fn get(&self, id: &str) -> Option<SessionSnapshot> {
        let mut registry = lock(&self.inner);
        Self::prune(&mut registry);
        registry.entries.get(id).map(|entry| snapshot(id, entry))
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
                let page = lock(&entry.output).page(offset, length)?;
                Ok(Some(SessionOutput {
                    session: snapshot(id, &entry),
                    page,
                }))
            }
        }
    }

    /// Request termination of only this Agent-owned command. A stop request
    /// is not evidence that cleanup was confirmed: call get to reconcile.
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

    /// Owner revocation closes admission first, then stops every owned
    /// command. Unknown cleanup or a bounded wait timeout fails closed.
    pub fn stop_all(&self, wait: Duration) -> CleanupState {
        let entries: Vec<Entry> = {
            let mut registry = lock(&self.inner);
            registry.closed = true;
            let entries: Vec<_> = registry.entries.values().cloned().collect();
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
                } else if record.cleanup != Some(CleanupState::Confirmed) {
                    confirmed = false;
                }
            }
            if all_finished {
                return if confirmed {
                    CleanupState::Confirmed
                } else {
                    CleanupState::Unknown
                };
            }
            if Instant::now() >= deadline {
                return CleanupState::Unknown;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for LinuxManagedSessions {
    fn drop(&mut self) {
        let registry = lock(&self.inner);
        for entry in registry.entries.values() {
            entry.stop.store(true, Ordering::Release);
        }
    }
}
