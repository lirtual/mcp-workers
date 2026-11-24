//! Disposable Gate 1 composition proof: signed WSS transport + persisted Gate 0
//! receipt-protected write, with one private, hard-coded test file only.
//! Not a general file executor, installable Agent or advertised write capability.
use crate::gate0_probe::{Gate0Probe, ProbeError};
use crate::session::{self, ExecutionRequest, ExecutionResponse, HeartbeatTiming, SessionError};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DisposableFileError {
    #[error(transparent)]
    Probe(#[from] ProbeError),
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error("disposable file response queue full")]
    Queue,
    #[error("disposable file executor panicked")]
    Panicked,
}

fn execute(
    mut probe: Gate0Probe,
    stop: &Arc<AtomicBool>,
    requests: &Receiver<ExecutionRequest>,
    replies: &SyncSender<ExecutionResponse>,
) -> Result<(), DisposableFileError> {
    while !stop.load(Ordering::Acquire) {
        let request = match requests.recv_timeout(Duration::from_millis(100)) {
            Ok(request) => request,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let Some(frame) = request.frame_if_active() else {
            continue;
        };
        // The lease is checked both before the effect and before replying.
        // Once admitted, a write may complete after revocation; its receipt
        // persists, and no reply from an old socket may escape.
        if !request.lease().is_active() {
            continue;
        }
        let result = match probe.handle(frame) {
            Ok(result) => result,
            Err(error) => {
                // This test-only general pump cannot emit a 1008 policy close.
                // Fail the complete candidate session closed; never redial.
                stop.store(true, Ordering::Release);
                return Err(error.into());
            }
        };
        if !request.lease().is_active() {
            continue;
        }
        match replies.try_send(request.response(result)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                stop.store(true, Ordering::Release);
                return Err(DisposableFileError::Queue);
            }
            Err(TrySendError::Disconnected(_)) => break,
        }
    }
    Ok(())
}

/// Only accepts the Gate 0 private `rca-rust-probe-*` root and its fresh
/// `probe.txt`. All general file paths, existing files and Shell are rejected.
/// The SQLite receipt is opened before any network connection is attempted.
pub fn run_disposable_file_session(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    probe_root: &Path,
    stop: &Arc<AtomicBool>,
    timing: HeartbeatTiming,
) -> Result<(), DisposableFileError> {
    let probe = Gate0Probe::new(probe_root)?;
    let (request_sender, requests) = sync_channel(4);
    let (reply_sender, replies) = sync_channel(4);
    let worker_stop = Arc::clone(stop);
    let worker = std::thread::spawn(move || execute(probe, &worker_stop, &requests, &reply_sender));
    let session = session::maintain_authenticated_transport(
        endpoint,
        private_pem,
        device_id,
        stop,
        &request_sender,
        &replies,
        timing,
    );
    stop.store(true, Ordering::Release);
    let executor = worker.join().map_err(|_| DisposableFileError::Panicked)?;
    executor?;
    session?;
    Ok(())
}

// This is the Gate 1 native file-session candidate. The older disposable
// Gate 0 probe above remains an isolated regression fixture until migration.
#[cfg(target_os = "macos")]
use crate::darwin_managed::{CleanupState, DarwinManagedSessions as ManagedSessions};
#[cfg(target_os = "linux")]
use crate::linux_managed::LinuxManagedSessions as ManagedSessions;
#[cfg(target_os = "linux")]
use crate::linux_supervisor::CleanupState;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
use crate::native_process::{self, NativeProcessEngine, ProcessRead};
use crate::native_read::{self, ReadCommand};
use crate::native_search::{self, SearchFrame, SearchSessions};
use crate::native_write::{NativeWriteError, NativeWriteExecutor};
#[cfg(unix)]
use crate::upgrade_control::{UpgradeCommand, UpgradeRequest, UpgradeServer};
#[cfg(windows)]
use crate::windows_job::JobCleanup as CleanupState;
#[cfg(windows)]
use crate::windows_managed::WindowsManagedSessions as ManagedSessions;
#[cfg(windows)]
use crate::windows_upgrade_control::{UpgradeCommand, UpgradeRequest, UpgradeServer};
use serde_json::{json, Value};

pub(crate) enum NativeFileCommand {
    Read(ReadCommand),
    Search(SearchFrame),
    Mutation {
        request_id: String,
        operation_id: String,
        tool: String,
        arguments: Value,
    },
    Status {
        request_id: String,
        operation_id: String,
    },
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    ProcessRead {
        request_id: String,
        read: ProcessRead,
    },
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    ProcessMutation {
        request_id: String,
        operation_id: String,
        tool: String,
        arguments: Value,
    },
}

/// Parse the entire authenticated file frame before enqueueing it. Unknown
/// tools are a 1008 policy violation, not an invitation to execute a command.
pub(crate) fn parse_native_file_frame(frame: &str) -> Result<NativeFileCommand, ()> {
    if frame.len() > 65_536 {
        return Err(());
    }
    let message: Value = serde_json::from_str(frame).map_err(|_| ())?;
    let object = message.as_object().ok_or(())?;
    if object.get("kind").and_then(Value::as_str) == Some("read") {
        if let Some(search) = native_search::parse_frame(object) {
            return search.map(NativeFileCommand::Search);
        }
        return native_read::parse_read_frame(frame)
            .map(NativeFileCommand::Read)
            .map_err(|_| ());
    }
    if object.len() != 5 || object.get("kind").and_then(Value::as_str) != Some("operation") {
        return Err(());
    }
    let request_id = object.get("request_id").and_then(Value::as_str).ok_or(())?;
    if !crate::identity::valid_device_id(request_id) {
        return Err(());
    }
    let operation_id = object
        .get("operation_id")
        .and_then(Value::as_str)
        .ok_or(())?;
    if !crate::receipts::valid_id(operation_id) {
        return Err(());
    }
    let tool = object.get("tool").and_then(Value::as_str).ok_or(())?;
    let arguments = object.get("arguments").ok_or(())?;
    match tool {
        "write_file" if crate::native_write::valid_write_args(arguments) => {
            Ok(NativeFileCommand::Mutation {
                request_id: request_id.to_owned(),
                operation_id: operation_id.to_owned(),
                tool: tool.to_owned(),
                arguments: arguments.clone(),
            })
        }
        "create_directory" | "delete_file" if crate::native_write::valid_path_args(arguments) => {
            Ok(NativeFileCommand::Mutation {
                request_id: request_id.to_owned(),
                operation_id: operation_id.to_owned(),
                tool: tool.to_owned(),
                arguments: arguments.clone(),
            })
        }
        "edit_block" if crate::native_write::valid_edit_args(arguments) => {
            Ok(NativeFileCommand::Mutation {
                request_id: request_id.to_owned(),
                operation_id: operation_id.to_owned(),
                tool: tool.to_owned(),
                arguments: arguments.clone(),
            })
        }
        "move_file" if crate::native_write::valid_move_args(arguments) => {
            Ok(NativeFileCommand::Mutation {
                request_id: request_id.to_owned(),
                operation_id: operation_id.to_owned(),
                tool: tool.to_owned(),
                arguments: arguments.clone(),
            })
        }
        "get_operation_status"
            if arguments.as_object().is_some_and(|args| {
                args.len() == 1
                    && args.get("operation_id").and_then(Value::as_str) == Some(operation_id)
            }) =>
        {
            Ok(NativeFileCommand::Status {
                request_id: request_id.to_owned(),
                operation_id: operation_id.to_owned(),
            })
        }
        _ => Err(()),
    }
}

/// The extended policy admits process frames only in an explicit platform
/// nonproduction managed runtime. The existing file-only policy is unchanged.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(crate) fn parse_native_managed_frame(frame: &str) -> Result<NativeFileCommand, ()> {
    if let Ok(file) = parse_native_file_frame(frame) {
        return Ok(file);
    }
    if frame.len() > 65_536 {
        return Err(());
    }
    let message: Value = serde_json::from_str(frame).map_err(|_| ())?;
    let object = message.as_object().ok_or(())?;
    let kind = object.get("kind").and_then(Value::as_str).ok_or(())?;
    let request_id = object.get("request_id").and_then(Value::as_str).ok_or(())?;
    if !crate::identity::valid_device_id(request_id) {
        return Err(());
    }
    let tool = object.get("tool").and_then(Value::as_str).ok_or(())?;
    let arguments = object.get("arguments").ok_or(())?;
    if kind == "read" && object.len() == 4 {
        let read = native_process::parse_process_read(tool, arguments).ok_or(())?;
        return Ok(NativeFileCommand::ProcessRead {
            request_id: request_id.to_owned(),
            read,
        });
    }
    if kind == "operation" && object.len() == 5 {
        let operation_id = object
            .get("operation_id")
            .and_then(Value::as_str)
            .ok_or(())?;
        if !crate::receipts::valid_id(operation_id)
            || native_process::parse_process_mutation(tool, arguments).is_none()
        {
            return Err(());
        }
        return Ok(NativeFileCommand::ProcessMutation {
            request_id: request_id.to_owned(),
            operation_id: operation_id.to_owned(),
            tool: tool.to_owned(),
            arguments: arguments.clone(),
        });
    }
    Err(())
}

#[derive(Debug, Error)]
pub enum NativeFileError {
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error(transparent)]
    Write(#[from] NativeWriteError),
    #[error("unexpected authenticated file frame")]
    Policy,
    #[error("native file response queue is full")]
    Queue,
    #[error("native file executor panicked")]
    Panicked,
    #[cfg(any(unix, windows))]
    #[error("owner-local upgrade control unavailable")]
    UpgradeUnavailable,
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[error("native managed-session cleanup remains uncertain")]
    CleanupUncertain,
}

fn execute_native_file(
    mut writes: NativeWriteExecutor,
    #[cfg(any(target_os = "linux", target_os = "macos", windows))] managed: Option<
        Arc<ManagedSessions>,
    >,
    #[cfg(any(target_os = "linux", target_os = "macos", windows))] cleanup_ready: Option<
        Receiver<()>,
    >,
    #[cfg(any(unix, windows))] upgrade_requests: Option<Receiver<UpgradeRequest>>,
    stop: &Arc<AtomicBool>,
    requests: &Receiver<ExecutionRequest>,
    replies: &SyncSender<ExecutionResponse>,
) -> Result<(), NativeFileError> {
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    let mut processes = managed.map(NativeProcessEngine::new);
    #[cfg(any(unix, windows))]
    let mut upgrade_frozen = false;
    let mut searches = SearchSessions::default();
    while !stop.load(Ordering::Acquire) {
        // Expire idle cursors even if the Owner never sends another request.
        searches.expire();
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        if let Some(process) = processes.as_mut() {
            process
                .reconcile(writes.receipt_store_mut())
                .map_err(NativeWriteError::from)?;
        }
        #[cfg(any(unix, windows))]
        if let Some(control) = upgrade_requests.as_ref() {
            while let Ok(request) = control.try_recv() {
                let answer = match request.command {
                    UpgradeCommand::Freeze
                        if !upgrade_frozen
                            && !stop.load(Ordering::Acquire)
                            && processes
                                .as_ref()
                                .is_some_and(NativeProcessEngine::is_quiescent_for_upgrade) =>
                    {
                        upgrade_frozen = true;
                        "ready\n"
                    }
                    UpgradeCommand::Freeze => "busy\n",
                    UpgradeCommand::VerifyFrozen
                        if upgrade_frozen
                            && !stop.load(Ordering::Acquire)
                            && processes
                                .as_ref()
                                .is_some_and(NativeProcessEngine::is_quiescent_for_upgrade) =>
                    {
                        "ready\n"
                    }
                    UpgradeCommand::VerifyFrozen => "busy\n",
                    UpgradeCommand::Release => {
                        upgrade_frozen = false;
                        "released\n"
                    }
                };
                let _ = request.reply.send(answer);
            }
        }
        let request = match requests.recv_timeout(Duration::from_millis(100)) {
            Ok(request) => request,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let Some(frame) = request.frame_if_active() else {
            continue;
        };
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        let command = if processes.is_some() {
            parse_native_managed_frame(frame)
        } else {
            parse_native_file_frame(frame)
        }
        .map_err(|_| NativeFileError::Policy)?;
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        let command = parse_native_file_frame(frame).map_err(|_| NativeFileError::Policy)?;
        if !request.lease().is_active() {
            continue;
        }
        #[cfg(any(unix, windows))]
        if upgrade_frozen {
            // Match the existing Node WSS envelopes without effect or receipt
            // admission. A frozen read is a failed read_result; a frozen
            // mutation/status query is an unavailable operation_result.
            let frame: Value = serde_json::from_str(frame).map_err(|_| NativeFileError::Policy)?;
            let id = frame["request_id"]
                .as_str()
                .ok_or(NativeFileError::Policy)?;
            let response = if frame["kind"] == "read" {
                json!({"kind":"read_result","request_id":id,"status":"failed"})
            } else {
                let operation_id = frame["operation_id"]
                    .as_str()
                    .ok_or(NativeFileError::Policy)?;
                json!({"kind":"operation_result","request_id":id,
                    "result":{"operation_id":operation_id,"status":"unavailable"}})
            };
            if replies
                .try_send(request.response(response.to_string()))
                .is_err()
            {
                stop.store(true, Ordering::Release);
                return Err(NativeFileError::Queue);
            }
            continue;
        }
        let response = match command {
            NativeFileCommand::Read(read) => native_read::execute_read_frame(&read),
            NativeFileCommand::Search(search) => searches.execute(&search),
            NativeFileCommand::Mutation {
                request_id,
                operation_id,
                tool,
                arguments,
            } => {
                let result = match tool.as_str() {
                    "write_file" => writes.write_file_with_lease(&operation_id, &arguments, || {
                        request.lease().is_active()
                    }),
                    "create_directory" => {
                        writes.create_directory_with_lease(&operation_id, &arguments, || {
                            request.lease().is_active()
                        })
                    }
                    "delete_file" => {
                        writes.delete_file_with_lease(&operation_id, &arguments, || {
                            request.lease().is_active()
                        })
                    }
                    "edit_block" => writes.edit_block_with_lease(&operation_id, &arguments, || {
                        request.lease().is_active()
                    }),
                    "move_file" => writes.move_file_with_lease(&operation_id, &arguments, || {
                        request.lease().is_active()
                    }),
                    _ => return Err(NativeFileError::Policy),
                };
                let outcome = match result {
                    Ok(outcome) => outcome,
                    Err(NativeWriteError::LeaseRevoked) => continue,
                    Err(error) => {
                        // An unpersistable mutation may already have had an
                        // effect. Stop this candidate; never retry that ID.
                        stop.store(true, Ordering::Release);
                        return Err(error.into());
                    }
                };
                json!({"kind":"operation_result","request_id":request_id,
                    "result":{"operation_id":operation_id,"status":outcome.state,"receipt":outcome.receipt}}).to_string()
            }
            #[cfg(any(target_os = "linux", target_os = "macos", windows))]
            NativeFileCommand::ProcessRead { request_id, read } => {
                native_process::execute_process_read(
                    &processes.as_ref().ok_or(NativeFileError::Policy)?.sessions,
                    &request_id,
                    &read,
                )
            }
            #[cfg(any(target_os = "linux", target_os = "macos", windows))]
            NativeFileCommand::ProcessMutation {
                request_id,
                operation_id,
                tool,
                arguments,
            } => {
                let result = processes.as_mut().ok_or(NativeFileError::Policy)?.execute(
                    writes.receipt_store_mut(),
                    &operation_id,
                    &tool,
                    &arguments,
                    || request.lease().is_active(),
                );
                let outcome = match result {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        // Admission/update can fail after an effect: stop and
                        // preserve the guarded receipt; never replay.
                        stop.store(true, Ordering::Release);
                        return Err(NativeWriteError::from(error).into());
                    }
                };
                json!({"kind":"operation_result", "request_id":request_id,
                    "result":{"operation_id":operation_id, "status":outcome.state,
                        "session_id":outcome.session_id, "receipt":outcome.receipt}})
                .to_string()
            }
            NativeFileCommand::Status {
                request_id,
                operation_id,
            } => {
                let receipt = writes.get_receipt(&operation_id)?;
                let status = receipt.as_ref().map_or("not_found", |r| r.state.as_str());
                json!({"kind":"operation_result","request_id":request_id,
                    "result":{"operation_id":operation_id,"status":status,"receipt":receipt}})
                .to_string()
            }
        };
        if !request.lease().is_active() {
            continue;
        }
        match replies.try_send(request.response(response)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                stop.store(true, Ordering::Release);
                return Err(NativeFileError::Queue);
            }
            Err(TrySendError::Disconnected(_)) => break,
        }
    }
    // Do not close the one SQLite receipt owner until native group cleanup has
    // finished. A stop flag alone does not prove the OS-owned job has exited.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    if let Some(ready) = cleanup_ready {
        let _ = ready.recv();
    }
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    if let Some(process) = processes.as_mut() {
        process
            .reconcile(writes.receipt_store_mut())
            .map_err(NativeWriteError::from)?;
    }
    Ok(())
}

/// A non-installable file runtime: receipt exclusivity is obtained before
/// signed WSS admission. Native file reads, bounded in-memory search,
/// write_file, create_directory, delete_file, move_file, edit_block and receipt
/// lookup are admitted; Shell/sessions/install/upgrade are rejected with 1008.
pub fn run_native_file_session(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    receipt_directory: &Path,
    stop: &Arc<AtomicBool>,
    timing: HeartbeatTiming,
) -> Result<(), NativeFileError> {
    let writes = NativeWriteExecutor::open(receipt_directory)?;
    let (request_sender, requests) = sync_channel(4);
    let (reply_sender, replies) = sync_channel(4);
    let worker_stop = Arc::clone(stop);
    let worker = std::thread::spawn(move || {
        let result = execute_native_file(
            writes,
            #[cfg(any(target_os = "linux", target_os = "macos", windows))]
            None,
            #[cfg(any(target_os = "linux", target_os = "macos", windows))]
            None,
            #[cfg(any(unix, windows))]
            None,
            &worker_stop,
            &requests,
            &reply_sender,
        );
        if result.is_err() {
            worker_stop.store(true, Ordering::Release);
        }
        result
    });
    let session = session::maintain_native_file_transport(
        endpoint,
        private_pem,
        device_id,
        stop,
        &request_sender,
        &replies,
        timing,
    );
    stop.store(true, Ordering::Release);
    let executor = worker.join().map_err(|_| NativeFileError::Panicked)?;
    executor?;
    session?;
    Ok(())
}

/// Non-installable Linux/macOS/Windows candidate: one SQLite receipt owner serves
/// both file and process mutations, using platform-owned process isolation.
/// No installed identity, production URL or advertised capability.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub fn run_native_managed_session(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    receipt_directory: &Path,
    managed: Arc<ManagedSessions>,
    stop: &Arc<AtomicBool>,
    timing: HeartbeatTiming,
) -> Result<(), NativeFileError> {
    run_native_managed_session_inner(
        endpoint,
        private_pem,
        device_id,
        receipt_directory,
        managed,
        stop,
        ManagedRunOptions {
            timing,
            upgrade_key: None,
            on_connected: None,
            on_disconnected: None,
        },
    )
}

/// Candidate path with the Node installer's exact owner-local upgrade IPC.
#[cfg(any(unix, windows))]
pub fn run_native_managed_session_with_upgrade(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    receipt_directory: &Path,
    managed: Arc<ManagedSessions>,
    stop: &Arc<AtomicBool>,
    upgrade: UpgradeRuntimeOptions<'_>,
) -> Result<(), NativeFileError> {
    run_native_managed_session_inner(
        endpoint,
        private_pem,
        device_id,
        receipt_directory,
        managed,
        stop,
        ManagedRunOptions {
            timing: HeartbeatTiming::default(),
            upgrade_key: Some(upgrade.key_path),
            on_connected: upgrade.on_connected,
            on_disconnected: upgrade.on_disconnected,
        },
    )
}

#[cfg(any(unix, windows))]
pub struct UpgradeRuntimeOptions<'a> {
    pub key_path: &'a Path,
    pub on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
    pub on_disconnected: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
struct ManagedRunOptions<'a> {
    timing: HeartbeatTiming,
    upgrade_key: Option<&'a Path>,
    on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
    on_disconnected: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn run_native_managed_session_inner(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    receipt_directory: &Path,
    managed: Arc<ManagedSessions>,
    stop: &Arc<AtomicBool>,
    options: ManagedRunOptions<'_>,
) -> Result<(), NativeFileError> {
    let writes = NativeWriteExecutor::open(receipt_directory)?;
    #[cfg(any(unix, windows))]
    let (_upgrade_server, upgrade_requests) = if let Some(key) = options.upgrade_key {
        let (sender, requests) = sync_channel(4);
        let server =
            UpgradeServer::bind(key, sender).map_err(|_| NativeFileError::UpgradeUnavailable)?;
        (Some(server), Some(requests))
    } else {
        (None, None)
    };
    let (request_sender, requests) = sync_channel(4);
    let (reply_sender, replies) = sync_channel(4);
    let worker_stop = Arc::clone(stop);
    let worker_managed = Arc::clone(&managed);
    // A one-shot barrier orders final receipt reconciliation strictly after
    // OS-owned process cleanup (including the Owner revoke acknowledgement).
    let (cleanup_notifier, cleanup_ready) = sync_channel(1);
    let worker = std::thread::spawn(move || {
        let result = execute_native_file(
            writes,
            Some(worker_managed),
            Some(cleanup_ready),
            #[cfg(any(unix, windows))]
            upgrade_requests,
            &worker_stop,
            &requests,
            &reply_sender,
        );
        if result.is_err() {
            worker_stop.store(true, Ordering::Release);
        }
        result
    });
    let session = session::maintain_native_managed_transport(
        endpoint,
        private_pem,
        device_id,
        stop,
        &request_sender,
        &replies,
        session::ManagedTransportConfig {
            timing: options.timing,
            managed: Arc::clone(&managed),
            on_connected: options.on_connected,
            on_disconnected: options.on_disconnected,
        },
    );
    stop.store(true, Ordering::Release);
    let cleanup = managed.stop_all(Duration::from_secs(8));
    let _ = cleanup_notifier.send(());
    let executor = worker.join().map_err(|_| NativeFileError::Panicked)?;
    executor?;
    if cleanup != CleanupState::Confirmed {
        return Err(NativeFileError::CleanupUncertain);
    }
    session?;
    Ok(())
}
