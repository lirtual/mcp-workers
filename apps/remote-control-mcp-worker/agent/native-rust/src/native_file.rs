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
use crate::native_read::{self, ReadCommand};
use crate::native_write::{NativeWriteError, NativeWriteExecutor};
use serde_json::{json, Value};

pub(crate) enum NativeFileCommand {
    Read(ReadCommand),
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
}

fn execute_native_file(
    mut writes: NativeWriteExecutor,
    stop: &Arc<AtomicBool>,
    requests: &Receiver<ExecutionRequest>,
    replies: &SyncSender<ExecutionResponse>,
) -> Result<(), NativeFileError> {
    while !stop.load(Ordering::Acquire) {
        let request = match requests.recv_timeout(Duration::from_millis(100)) {
            Ok(request) => request,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let Some(frame) = request.frame_if_active() else {
            continue;
        };
        let command = parse_native_file_frame(frame).map_err(|_| NativeFileError::Policy)?;
        if !request.lease().is_active() {
            continue;
        }
        let response = match command {
            NativeFileCommand::Read(read) => native_read::execute_read_frame(&read),
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
    Ok(())
}

/// A non-installable file runtime: receipt exclusivity is obtained before
/// signed WSS admission. Only native file reads, write_file, create_directory,
/// delete_file, move_file and receipt lookup are allowed; Shell/sessions/install/upgrade
/// are rejected with 1008.
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
        let result = execute_native_file(writes, &worker_stop, &requests, &reply_sender);
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
