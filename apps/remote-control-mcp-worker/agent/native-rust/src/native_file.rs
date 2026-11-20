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
