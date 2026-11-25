//! Nonproduction Unix managed-session registry shared by Linux and Darwin.
//! Durable receipt admission and Owner authorization precede all dispatch.
#![cfg(any(target_os = "linux", target_os = "macos"))]

#[cfg(target_os = "macos")]
use crate::darwin_output::{BoundedProcessOutput, OutputPage};
#[cfg(target_os = "macos")]
use crate::darwin_supervisor::{
    DarwinSupervisorExit as SupervisorExit, DarwinSupervisorSession as SupervisorSession,
    GroupCleanup,
};
#[cfg(target_os = "linux")]
use crate::linux_command::valid_command_text;
#[cfg(target_os = "linux")]
use crate::linux_output::{BoundedProcessOutput, OutputPage};
#[cfg(target_os = "linux")]
use crate::linux_supervisor::{CleanupState, SupervisorExit, SupervisorSession};
use std::collections::HashMap;
use std::io::{self, ErrorKind, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::ChildStdin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupState {
    Confirmed,
    Unknown,
}

#[cfg(target_os = "macos")]
pub(crate) fn valid_command_text(command: &str) -> bool {
    !command.is_empty()
        && !command.contains(char::from(0))
        && command.encode_utf16().take(8193).count() <= 8192
}

#[cfg(target_os = "macos")]
fn exit_cleanup(exit: &SupervisorExit) -> CleanupState {
    match exit.group_cleanup {
        GroupCleanup::OwnedGroupStopped => CleanupState::Confirmed,
        GroupCleanup::Unknown => CleanupState::Unknown,
    }
}

#[cfg(target_os = "linux")]
fn exit_cleanup(exit: &SupervisorExit) -> CleanupState {
    exit.cleanup
}

const MAX_SESSIONS: usize = 10;
const MAX_HISTORY: usize = 10;
const HISTORY_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_LIFETIME: Duration = Duration::from_secs(60 * 60);
const POLL: Duration = Duration::from_millis(50);
const STOP_GRACE: Duration = Duration::from_millis(500);
const DEADLINE_GRACE: Duration = Duration::from_secs(5);
const INPUT_WRITE_LIMIT: Duration = Duration::from_secs(1);

/// Only this typed error proves capacity was rejected before any OS launch.
/// Raw WouldBlock can also come from a thread spawn after the process started.
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

struct Entry {
    started_at: String,
    record: Mutex<Record>,
    output: Mutex<Option<BoundedProcessOutput>>,
    stdin: Mutex<Option<ChildStdin>>,
    stop: AtomicBool,
}

struct Registry {
    closed: bool,
    entries: HashMap<String, Arc<Entry>>,
}

/// At most ten owned live/uncertain Unix commands. Completed history is
/// bounded independently, and an unknown cleanup never frees active capacity.
pub struct UnixManagedSessions {
    helper: PathBuf,
    shell: PathBuf,
    lifetime: Duration,
    inner: Mutex<Registry>,
}

#[cfg(target_os = "linux")]
pub type LinuxManagedSessions = UnixManagedSessions;
#[cfg(target_os = "macos")]
pub type DarwinManagedSessions = UnixManagedSessions;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
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

/// Format the same ISO-8601 UTC startup timestamp as Node, using the
/// platform libc instead of introducing a second date library.
fn startup_clock() -> io::Result<(String, u64)> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    let seconds = elapsed.as_secs() as libc::time_t;
    let mut utc = std::mem::MaybeUninit::<libc::tm>::uninit();
    if unsafe { libc::gmtime_r(&seconds, utc.as_mut_ptr()) }.is_null() {
        return Err(io::Error::last_os_error());
    }
    let utc = unsafe { utc.assume_init() };
    Ok((
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            utc.tm_year + 1900,
            utc.tm_mon + 1,
            utc.tm_mday,
            utc.tm_hour,
            utc.tm_min,
            utc.tm_sec,
            elapsed.subsec_millis()
        ),
        elapsed.as_millis() as u64,
    ))
}

fn snapshot(id: &str, entry: &Entry) -> SessionSnapshot {
    let state = lock(&entry.record);
    // Node refreshes the observation clock on every snapshot (get/list/read).
    // This timestamp is presentation-only; registry TTL uses finished_at.
    let last_observed_at = startup_clock()
        .map(|(iso, _)| iso)
        .unwrap_or_else(|_| entry.started_at.clone());
    SessionSnapshot {
        session_id: id.to_owned(),
        started_at: entry.started_at.clone(),
        last_observed_at,
        state: state.state,
        exit_code: state.exit_code,
        cleanup: state.cleanup,
        deadline_exceeded: state.deadline_exceeded,
    }
}

fn supervise(mut supervisor: SupervisorSession, entry: Arc<Entry>, deadline: Instant) {
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
    if let Some(output) = lock(&entry.output).as_mut() {
        output.stop();
    }
    lock(&entry.stdin).take();
    let mut state = lock(&entry.record);
    state.deadline_exceeded = expired;
    state.finished_at = Some(Instant::now());
    match outcome {
        Ok(exit) => {
            state.exit_code = exit.status.code();
            let cleanup = exit_cleanup(&exit);
            state.cleanup = Some(cleanup);
            state.state = if cleanup == CleanupState::Unknown {
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

/// If a native command may have started but cannot be registered or
/// monitored, never free its capacity or claim Owner cleanup was confirmed.
fn mark_uncertain(entry: &Entry) {
    entry.stop.store(true, Ordering::Release);
    lock(&entry.stdin).take();
    if let Some(output) = lock(&entry.output).as_mut() {
        output.stop();
    }
    let mut record = lock(&entry.record);
    record.state = SessionState::Unknown;
    record.cleanup = Some(CleanupState::Unknown);
    record.finished_at = Some(Instant::now());
}

impl UnixManagedSessions {
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

    /// Reserve an owned session before touching the OS. Startup does not
    /// hold the registry lock: concurrent revocation can close admission and
    /// see the pending session even during a slow supervisor handshake.
    pub fn start(&self, command: &str) -> io::Result<SessionSnapshot> {
        if !valid_command_text(command) {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "invalid command text",
            ));
        }
        let id = new_session_id()?;
        let (started_at, _) = startup_clock()?;
        let entry = Arc::new(Entry {
            started_at,
            record: Mutex::new(Record {
                state: SessionState::Running,
                exit_code: None,
                cleanup: None,
                deadline_exceeded: false,
                finished_at: None,
            }),
            output: Mutex::new(None),
            stdin: Mutex::new(None),
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
            let mut record = lock(&entry.record);
            record.state = SessionState::Failed;
            record.cleanup = Some(CleanupState::Confirmed); // No native launch.
            record.finished_at = Some(Instant::now());
            return Err(io::Error::new(
                ErrorKind::Interrupted,
                "session revoked before launch",
            ));
        }

        let spawned_at = Instant::now();
        let mut supervisor = match SupervisorSession::start(&self.helper, &self.shell, command) {
            Ok(supervisor) => supervisor,
            Err(error) => {
                // The supervisor handshake can fail after its OS process has
                // already launched. Its Drop is best effort, not proof of reap.
                mark_uncertain(&entry);
                return Err(error);
            }
        };
        let stdin = match supervisor.take_stdin() {
            Some(stdin) => stdin,
            None => {
                let _ = supervisor.close_control_and_wait(Duration::from_secs(5));
                mark_uncertain(&entry);
                return Err(io::Error::other("native stdin missing after launch"));
            }
        };
        let output = match BoundedProcessOutput::attach(&mut supervisor) {
            Ok(output) => output,
            Err(error) => {
                let _ = supervisor.close_control_and_wait(Duration::from_secs(5));
                mark_uncertain(&entry);
                return Err(error);
            }
        };
        *lock(&entry.output) = Some(output);
        *lock(&entry.stdin) = Some(stdin);
        let worker = Arc::clone(&entry);
        let deadline = spawned_at + self.lifetime;
        if let Err(error) = thread::Builder::new()
            .name("rca-owned-unix-session".to_owned())
            .spawn(move || supervise(supervisor, worker, deadline))
        {
            // The closure has dropped the supervisor; its cleanup cannot be
            // independently verified, so preserve an Unknown owned entry.
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

    /// A single bounded nonblocking stdin write. The caller must persist a
    /// distinct receipt before invoking this potentially effectful action:
    /// Unknown (including a timeout or partial write) must never be replayed.
    pub fn write_input(&self, id: &str, input: &str) -> InputOutcome {
        self.write_input_inner(id, input, false)
    }

    pub fn write_secure_input(&self, id: &str, input: &str) -> InputOutcome {
        self.write_input_inner(id, input, true)
    }

    pub(crate) fn secure_input_ready(&self, id: &str) -> bool {
        self.get(id)
            .is_some_and(|session| session.state == SessionState::Running)
    }

    fn write_input_inner(&self, id: &str, input: &str, sensitive: bool) -> InputOutcome {
        // Secure input includes a newline delimiter after the 8192-byte value.
        let max = if sensitive { 8193 } else { 8192 };
        if input.is_empty() || input.len() > max || input.contains(char::from(0)) {
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
        // Contended callers must not wait behind another potentially
        // one-second pipe write and exceed the remote reply budget.
        let deadline = Instant::now() + INPUT_WRITE_LIMIT;
        let mut pipe = match entry.stdin.try_lock() {
            Ok(pipe) => pipe,
            Err(std::sync::TryLockError::Poisoned(poison)) => poison.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return InputOutcome::Unknown,
        };
        let Some(stdin) = pipe.as_mut() else {
            return InputOutcome::Unknown;
        };
        if sensitive {
            let output = lock(&entry.output);
            let Some(output) = output.as_ref() else {
                return InputOutcome::Failed;
            };
            output.suppress_sensitive();
        }
        let fd = stdin.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return InputOutcome::Unknown;
        }
        let bytes = input.as_bytes();
        let mut sent = 0;
        while sent < bytes.len() {
            if Instant::now() >= deadline {
                return InputOutcome::Unknown;
            }
            if entry.stop.load(Ordering::Acquire)
                || lock(&entry.record).state != SessionState::Running
            {
                return if sent == 0 {
                    InputOutcome::Failed
                } else {
                    InputOutcome::Unknown
                };
            }
            match stdin.write(&bytes[sent..]) {
                Ok(0) => return InputOutcome::Unknown,
                Ok(n) => sent += n,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return InputOutcome::Unknown;
                    }
                    let mut poll = libc::pollfd {
                        fd,
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    let millis = left.min(POLL).as_millis().max(1) as i32;
                    let result = unsafe { libc::poll(&mut poll, 1, millis) };
                    if result < 0 && io::Error::last_os_error().kind() != ErrorKind::Interrupted {
                        return InputOutcome::Unknown;
                    }
                }
                Err(_) => return InputOutcome::Unknown,
            }
        }
        // Natural exit after all bytes reach the pipe does not undo the
        // write. Concurrent revocation, however, leaves its effect uncertain.
        if entry.stop.load(Ordering::Acquire) {
            InputOutcome::Unknown
        } else {
            InputOutcome::Completed
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
        let entries: Vec<Arc<Entry>> = {
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

impl Drop for UnixManagedSessions {
    fn drop(&mut self) {
        let registry = lock(&self.inner);
        for entry in registry.entries.values() {
            entry.stop.store(true, Ordering::Release);
        }
    }
}
