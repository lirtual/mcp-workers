//! Disposable Gate 1 composition proof: signed WSS transport + persisted Gate 0
//! receipt-protected write, with one private, hard-coded test file only.
//! Not a general file executor, installable Agent or advertised write capability.
use crate::gate0_probe::{Gate0Probe, ProbeError};
use crate::session::{self, ExecutionRequest, ExecutionResponse, HeartbeatTiming, SessionError};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::mpsc::{error::TrySendError, Sender};

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
    replies: &Sender<ExecutionResponse>,
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
            Err(TrySendError::Closed(_)) => break,
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
    let (reply_sender, mut replies) = tokio::sync::mpsc::channel(4);
    let worker_stop = Arc::clone(stop);
    let worker = std::thread::spawn(move || execute(probe, &worker_stop, &requests, &reply_sender));
    let session = session::maintain_authenticated_transport(
        endpoint,
        private_pem,
        device_id,
        stop,
        &request_sender,
        &mut replies,
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
use crate::darwin_managed::InputOutcome as ManagedInputOutcome;
#[cfg(target_os = "macos")]
use crate::darwin_managed::{CleanupState, DarwinManagedSessions as ManagedSessions};
#[cfg(target_os = "linux")]
use crate::linux_managed::InputOutcome as ManagedInputOutcome;
#[cfg(target_os = "linux")]
use crate::linux_managed::LinuxManagedSessions as ManagedSessions;
#[cfg(target_os = "linux")]
use crate::linux_supervisor::CleanupState;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
use crate::native_process::{self, NativeProcessEngine, ProcessRead};
use crate::native_read::{self, ReadCommand};
use crate::native_search::{self, SearchFrame, SearchSessions};
use crate::native_write::{NativeWriteError, NativeWriteExecutor, WriteOutcome};
use crate::receipts::ReceiptError;
#[cfg(unix)]
use crate::upgrade_control::{UpgradeCommand, UpgradeRequest, UpgradeServer};
#[cfg(windows)]
use crate::windows_job::JobCleanup as CleanupState;
#[cfg(windows)]
use crate::windows_managed::InputOutcome as ManagedInputOutcome;
#[cfg(windows)]
use crate::windows_managed::WindowsManagedSessions as ManagedSessions;
#[cfg(windows)]
use crate::windows_upgrade_control::{UpgradeCommand, UpgradeRequest, UpgradeServer};
use serde_json::{json, Value};
use zeroize::Zeroize;

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

impl NativeFileError {
    pub fn diagnostic_event(&self) -> &'static str {
        match self {
            Self::Session(error) => error.diagnostic_event(),
            Self::Write(NativeWriteError::Receipt(error)) => error.diagnostic(),
            Self::Write(_) | Self::Panicked => "execution_unavailable",
            Self::Policy => "connection_protocol_unavailable",
            Self::Queue => "execution_queue_unavailable",
            #[cfg(any(unix, windows))]
            Self::UpgradeUnavailable => "upgrade_control_unavailable",
            #[cfg(any(target_os = "linux", target_os = "macos", windows))]
            Self::CleanupUncertain => "cleanup_uncertain",
        }
    }
}

struct LocalControl {
    requests: Receiver<UpgradeRequest>,
    idle_attempt: Option<crate::session_enrollment::SessionPhysicalAttempt>,
}

// Keep each platform-owned queue explicit; combining them would obscure their distinct lifetimes.
#[allow(clippy::too_many_arguments)]
fn execute_native_file(
    mut writes: NativeWriteExecutor,
    #[cfg(any(target_os = "linux", target_os = "macos", windows))] managed: Option<
        Arc<ManagedSessions>,
    >,
    #[cfg(any(target_os = "linux", target_os = "macos", windows))] cleanup_ready: Option<
        Receiver<()>,
    >,
    #[cfg(any(unix, windows))] local_control: Option<LocalControl>,
    stop: &Arc<AtomicBool>,
    requests: &Receiver<ExecutionRequest>,
    #[cfg(any(target_os = "linux", target_os = "macos", windows))] secure_requests: Option<
        &Receiver<session::SecureInputRequest>,
    >,
    replies: &Sender<ExecutionResponse>,
) -> Result<(), NativeFileError> {
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    let mut processes = managed.map(NativeProcessEngine::new);
    #[cfg(any(unix, windows))]
    let mut upgrade_frozen = false;
    if local_control
        .as_ref()
        .is_some_and(|c| c.idle_attempt.is_some())
    {
        if let Err(error) = writes.receipt_store_mut().enable_session_activity() {
            writes.isolate(&error)?;
            writes.receipt_store_mut().session_activity =
                Some(crate::session_idle::Activity::default());
        }
    }
    let mut searches = SearchSessions::with_boundary(writes.boundary().clone());
    let result = (|| -> Result<(), NativeFileError> {
        while !stop.load(Ordering::Acquire) {
            // Secure Input has its own bounded queue and bypasses generic operations and receipts.
            #[cfg(any(target_os = "linux", target_os = "macos", windows))]
            if let Some(queue) = secure_requests {
                if let Ok(mut secure) = queue.try_recv() {
                    if !secure.lease().is_active() {
                        continue;
                    }
                    let secure_lease = secure.lease().clone();
                    let response = match secure.command_mut() {
                        crate::secure_input::SecureInputCommand::Prepare { id, target } => {
                            match crate::secure_input::prepare(target) {
                                Ok(provider_principal) => {
                                    json!({"kind":"secure_input_prepare_result","preflight_id":id,"status":"ready","provider_principal":provider_principal})
                                }
                                Err(error_code) => {
                                    json!({"kind":"secure_input_prepare_result","preflight_id":id,"status":"failed","error_code":error_code})
                                }
                            }
                        }
                        crate::secure_input::SecureInputCommand::Submit {
                            id,
                            target,
                            principal,
                            secret,
                        } => {
                            let request_id = id.clone();
                            if replies.try_send(secure_lease.response(json!({"kind":"secure_input_ack","request_id":request_id,"status":"accepted"}).to_string())).is_err()
                                || replies.try_send(secure_lease.response(json!({"kind":"secure_input_progress","request_id":request_id,"status":"running"}).to_string())).is_err() {
                                stop.store(true, Ordering::Release);
                                return Err(NativeFileError::Queue);
                            }
                            let secret = std::mem::take(secret);
                            let (status, error_code) = match target {
                                crate::secure_input::SecureInputTarget::TaskProcess {
                                    session_id,
                                    ..
                                } => {
                                    let mut input = secret;
                                    input.push('\n');
                                    let outcome = processes
                                        .as_ref()
                                        .ok_or(NativeFileError::Policy)?
                                        .sessions
                                        .write_input(session_id.as_str(), &input);
                                    input.zeroize();
                                    match outcome {
                                        ManagedInputOutcome::Completed => ("succeeded", None),
                                        ManagedInputOutcome::Failed => {
                                            ("failed", Some("target_not_accessible"))
                                        }
                                        ManagedInputOutcome::Unknown => {
                                            ("unknown", Some("execution_interrupted"))
                                        }
                                        ManagedInputOutcome::NotFound => {
                                            ("failed", Some("target_not_accessible"))
                                        }
                                    }
                                }
                                provider_target => {
                                    let outcome = crate::secure_input::execute(
                                        provider_target,
                                        principal,
                                        secret,
                                        || !secure_lease.is_active(),
                                    );
                                    (outcome.status, outcome.error_code)
                                }
                            };
                            json!({"kind":"secure_input_result","request_id":request_id,"status":status,"error_code":error_code})
                        }
                    };
                    if secure.lease().is_active()
                        && replies
                            .try_send(secure_lease.response(response.to_string()))
                            .is_err()
                    {
                        stop.store(true, Ordering::Release);
                        return Err(NativeFileError::Queue);
                    }
                    continue;
                }
            }
            // Expire idle cursors even if the Owner never sends another request.
            searches.expire();
            #[cfg(any(target_os = "linux", target_os = "macos", windows))]
            if let Some(process) = processes.as_mut() {
                if writes.available() {
                    if let Err(error) = process.reconcile(writes.receipt_store_mut()) {
                        writes.isolate(&error)?;
                    }
                }
            }
            // For Session idle admission, inspect work already queued before
            // deciding to freeze. The same executor owns the subsequent gate;
            // newly arriving requests can never execute while it is frozen.
            let pending = if local_control
                .as_ref()
                .is_some_and(|c| c.idle_attempt.is_some())
            {
                requests.try_recv().ok()
            } else {
                None
            };
            #[cfg(any(unix, windows))]
            if let Some(control) = local_control.as_ref() {
                while let Ok(request) = control.requests.try_recv() {
                    let healthy = writes.available() && !stop.load(Ordering::Acquire);
                    let quiescent = processes
                        .as_ref()
                        .is_some_and(NativeProcessEngine::is_quiescent_for_upgrade);
                    let previously_frozen = upgrade_frozen;
                    let answer: String = match request.command {
                        UpgradeCommand::Freeze
                            if !upgrade_frozen && healthy && quiescent && pending.is_none() =>
                        {
                            upgrade_frozen = true;
                            "ready\n".into()
                        }
                        UpgradeCommand::Freeze => "busy\n".into(),
                        UpgradeCommand::VerifyFrozen if upgrade_frozen && healthy && quiescent => {
                            "ready\n".into()
                        }
                        UpgradeCommand::VerifyFrozen => "busy\n".into(),
                        UpgradeCommand::Release => {
                            upgrade_frozen = false;
                            "released\n".into()
                        }
                        #[cfg(unix)]
                        UpgradeCommand::IdleStatus | UpgradeCommand::IdleFreeze => {
                            let snapshot = control.idle_attempt.as_ref().and_then(|attempt| {
                                writes.receipt_store_mut().session_activity.as_mut().map(
                                    |activity| {
                                        activity.snapshot(
                                            attempt,
                                            healthy,
                                            !quiescent || pending.is_some(),
                                        )
                                    },
                                )
                            });
                            if request.command == UpgradeCommand::IdleStatus {
                                snapshot.map(|(_, frame)| frame).unwrap_or_default()
                            } else if !upgrade_frozen && snapshot.is_some_and(|(idle, _)| idle) {
                                upgrade_frozen = true;
                                "ready\n".into()
                            } else {
                                "busy\n".into()
                            }
                        }
                    };
                    // A timed-out caller must not leave an unacknowledged new freeze.
                    if request.reply.send(answer).is_err() && !previously_frozen {
                        upgrade_frozen = previously_frozen;
                    }
                }
            }
            let request = match pending
                .map(Ok)
                .unwrap_or_else(|| requests.recv_timeout(Duration::from_millis(100)))
            {
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
                let frame: Value =
                    serde_json::from_str(frame).map_err(|_| NativeFileError::Policy)?;
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
                NativeFileCommand::Read(read) => {
                    native_read::execute_read_frame_guarded(&read, Some(writes.boundary()))
                }
                NativeFileCommand::Search(search) => {
                    searches.execute_scoped(&search, request.lease(), request.reply_deadline())
                }
                NativeFileCommand::Mutation {
                    request_id,
                    operation_id,
                    tool,
                    arguments,
                } => {
                    let result = match tool.as_str() {
                        "write_file" => {
                            writes.write_file_with_lease(&operation_id, &arguments, || {
                                request.lease().is_active()
                            })
                        }
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
                        "edit_block" => {
                            writes.edit_block_with_lease(&operation_id, &arguments, || {
                                request.lease().is_active()
                            })
                        }
                        "move_file" => {
                            writes.move_file_with_lease(&operation_id, &arguments, || {
                                request.lease().is_active()
                            })
                        }
                        _ => return Err(NativeFileError::Policy),
                    };
                    let outcome = match result {
                        Ok(outcome) => outcome,
                        Err(NativeWriteError::LeaseRevoked) => continue,
                        Err(NativeWriteError::Receipt(error)) => {
                            writes.isolate(&error)?;
                            WriteOutcome {
                                state: if matches!(error, ReceiptError::AfterEffect(_)) {
                                    "unknown"
                                } else {
                                    "unavailable"
                                },
                                receipt: None,
                            }
                        }
                        Err(error) => return Err(error.into()),
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
                    let result = processes
                        .as_mut()
                        .ok_or(NativeFileError::Policy)?
                        .execute_before(
                            writes.receipt_store_mut(),
                            &operation_id,
                            &tool,
                            &arguments,
                            || request.lease().is_active(),
                            request.reply_deadline(),
                        );
                    let outcome = match result {
                        Ok(outcome) => outcome,
                        Err(error) => {
                            writes.isolate(&error)?;
                            let uncertain = matches!(error, ReceiptError::AfterEffect(_))
                                || processes
                                    .as_ref()
                                    .ok_or(NativeFileError::Policy)?
                                    .emergency_stop(&tool, &arguments, request.lease().is_active());
                            native_process::ProcessOutcome {
                                state: if uncertain { "unknown" } else { "unavailable" },
                                receipt: None,
                                session_id: None,
                            }
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
                    let (receipt, unavailable) = match writes.get_receipt(&operation_id) {
                        Ok(receipt) => (receipt, false),
                        Err(NativeWriteError::Receipt(error)) => {
                            writes.isolate(&error)?;
                            (None, true)
                        }
                        Err(error) => return Err(error.into()),
                    };
                    let status = if unavailable {
                        "unavailable"
                    } else {
                        receipt.as_ref().map_or("not_found", |r| r.state.as_str())
                    };
                    json!({"kind":"operation_result","request_id":request_id,
                    "result":{"operation_id":operation_id,"status":status,"receipt":receipt}})
                    .to_string()
                }
            };
            if let Some(activity) = writes.receipt_store_mut().session_activity.as_mut() {
                // Read and search completion are activity; observation-only
                // list_sessions, output and receipt queries are not.
                let input: Value =
                    serde_json::from_str(frame).map_err(|_| NativeFileError::Policy)?;
                let result: Value =
                    serde_json::from_str(&response).map_err(|_| NativeFileError::Policy)?;
                if (result["status"] == "completed" || result["error"] == "result_too_large")
                    && matches!(
                        input["tool"].as_str(),
                        Some(
                            "read_file"
                                | "read_multiple_files"
                                | "list_directory"
                                | "get_file_info"
                                | "start_search"
                                | "get_more_search_results"
                        )
                    )
                {
                    activity.touch();
                }
                if input["tool"] != "get_operation_status"
                    && result["result"]["status"] == "unknown"
                {
                    activity.mark_unknown();
                }
            }
            if !request.lease().is_active() {
                continue;
            }
            match replies.try_send(request.response(response)) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    stop.store(true, Ordering::Release);
                    return Err(NativeFileError::Queue);
                }
                Err(TrySendError::Closed(_)) => break,
            }
        }
        Ok(())
    })();
    // All error exits stop transport before waiting for managed cleanup.
    // Keep the SQLite owner alive through that barrier, including faults.
    stop.store(true, Ordering::Release);
    drop(searches);
    // Do not close the one SQLite receipt owner until native group cleanup has
    // finished. A stop flag alone does not prove the OS-owned job has exited.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    if let Some(ready) = cleanup_ready {
        let _ = ready.recv();
    }
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    if let Some(process) = processes.as_mut() {
        if writes.available() {
            if let Err(error) = process.reconcile(writes.receipt_store_mut()) {
                writes.isolate(&error)?;
            }
        }
    }
    result
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
    let writes = NativeWriteExecutor::open_runtime(receipt_directory, None)?;
    let (request_sender, requests) = sync_channel(4);
    let (reply_sender, mut replies) = tokio::sync::mpsc::channel(4);
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
            #[cfg(any(target_os = "linux", target_os = "macos", windows))]
            None,
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
        &mut replies,
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
            idle_attempt: None,
            on_connected: None,
            on_disconnected: None,
            on_diagnostic: None,
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
            idle_attempt: None,
            on_connected: upgrade.on_connected,
            on_disconnected: upgrade.on_disconnected,
            on_diagnostic: upgrade.on_diagnostic,
        },
    )
}

/// Verified GitHub Ubuntu Session: same owner-local IPC and execution owner.
#[cfg(target_os = "linux")]
pub fn run_native_session_with_idle(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    receipt_directory: &Path,
    managed: Arc<ManagedSessions>,
    stop: &Arc<AtomicBool>,
    identity: (&Path, crate::session_enrollment::SessionPhysicalAttempt),
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
            upgrade_key: Some(identity.0),
            idle_attempt: Some(identity.1),
            on_connected: None,
            on_disconnected: None,
            on_diagnostic: None,
        },
    )
}

#[cfg(any(unix, windows))]
pub struct UpgradeRuntimeOptions<'a> {
    pub key_path: &'a Path,
    pub on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
    pub on_disconnected: Option<Arc<dyn Fn() + Send + Sync>>,
    pub on_diagnostic: Option<session::DiagnosticSink>,
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
struct ManagedRunOptions<'a> {
    timing: HeartbeatTiming,
    upgrade_key: Option<&'a Path>,
    idle_attempt: Option<crate::session_enrollment::SessionPhysicalAttempt>,
    on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
    on_disconnected: Option<Arc<dyn Fn() + Send + Sync>>,
    on_diagnostic: Option<session::DiagnosticSink>,
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
    let writes =
        NativeWriteExecutor::open_runtime(receipt_directory, options.on_diagnostic.clone())?;
    let health = writes.health();
    let on_connected = options.on_connected.map(|callback| {
        let health = Arc::clone(&health);
        Arc::new(move || {
            if health.load(Ordering::Acquire) {
                callback();
            }
        }) as Arc<dyn Fn() + Send + Sync>
    });

    #[cfg(any(unix, windows))]
    let (_upgrade_server, local_control) = if let Some(key) = options.upgrade_key {
        let (sender, requests) = sync_channel(4);
        let server =
            UpgradeServer::bind(key, sender).map_err(|_| NativeFileError::UpgradeUnavailable)?;
        (
            Some(server),
            Some(LocalControl {
                requests,
                idle_attempt: options.idle_attempt,
            }),
        )
    } else {
        (None, None)
    };
    let (request_sender, requests) = sync_channel(4);
    let (secure_sender, secure_requests) = sync_channel(4);
    let (reply_sender, mut replies) = tokio::sync::mpsc::channel(4);
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
            local_control,
            &worker_stop,
            &requests,
            Some(&secure_requests),
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
        &mut replies,
        session::ManagedTransportConfig {
            receipt_health: health,
            timing: options.timing,
            managed: Arc::clone(&managed),
            secure_input: secure_sender,
            on_connected,
            on_disconnected: options.on_disconnected,
            on_diagnostic: options.on_diagnostic,
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
