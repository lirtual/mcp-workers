//! Nonproduction signed WSS login against the existing RCA Worker interface.
//! No installed Agent lifecycle, local operation executor, or automatic Owner Grant is provided.
#[cfg(target_os = "macos")]
use crate::darwin_managed::{CleanupState, DarwinManagedSessions as ManagedSessions};
use crate::identity::{signed_session_proof, valid_device_id};
#[cfg(target_os = "linux")]
use crate::linux_managed::LinuxManagedSessions as ManagedSessions;
#[cfg(target_os = "linux")]
use crate::linux_supervisor::CleanupState;
use crate::native_read::parse_read_frame;
#[cfg(windows)]
use crate::windows_job::JobCleanup as CleanupState;
#[cfg(windows)]
use crate::windows_managed::WindowsManagedSessions as ManagedSessions;
use futures_util::{SinkExt, StreamExt};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::runtime::Runtime;
use tokio::sync::mpsc::Receiver;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tungstenite::Message;
use url::Url;
use zeroize::Zeroize;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("untrusted RCA endpoint")]
    Endpoint,
    #[error("Agent identity is not authorized (HTTP {0})")]
    Rejected(u16),
    #[error("RCA Worker is temporarily unavailable (HTTP {0})")]
    Unavailable(u16),
    #[error("invalid or mismatched device challenge")]
    Challenge,
    #[error("RCA challenge request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("RCA WebSocket connection failed: {0}")]
    Ws(#[from] tungstenite::Error),
    #[error("RCA WebSocket TCP connection failed: {0}")]
    Io(#[from] io::Error),
    #[error("RCA Worker did not select rc-v2")]
    Protocol,
    #[error("RCA transport heartbeat timed out")]
    HeartbeatTimeout,
    #[error("RCA authorization proof liveness timed out")]
    AuthorizationTimeout,
    #[error("RCA Worker permanently rejected this session (close 1008)")]
    Policy,
    #[error("RCA signed session was replaced by another active socket")]
    Superseded,
    #[error("RCA authorization nonce entropy unavailable")]
    Entropy,
    #[error("RCA Agent execution channel unavailable or at capacity")]
    Queue,
}

impl SessionError {
    pub(crate) fn diagnostic_event(&self) -> &'static str {
        match self {
            Self::Rejected(_) | Self::Policy | Self::AuthorizationTimeout => {
                "authorization_unavailable"
            }
            Self::Endpoint | Self::Challenge | Self::Protocol | Self::Entropy => {
                "connection_protocol_unavailable"
            }
            Self::Unavailable(_) => "worker_unavailable",
            Self::HeartbeatTimeout => "heartbeat_timeout",
            Self::Superseded => "connection_superseded",
            Self::Queue => "execution_queue_unavailable",
            Self::Ws(tungstenite::Error::Http(response))
                if [401, 403, 404].contains(&response.status().as_u16()) =>
            {
                "authorization_unavailable"
            }
            Self::Ws(tungstenite::Error::Http(response))
                if [408, 425, 429].contains(&response.status().as_u16())
                    || response.status().is_server_error() =>
            {
                "worker_unavailable"
            }
            _ => "connection_unavailable",
        }
    }
}

// Only fixed classifications are emitted, never raw network or storage errors.
pub fn report_diagnostic(event: &'static str) {
    eprintln!(
        "{}",
        json!({"service":"remote-control-agent","event":event})
    );
}

pub type DiagnosticSink = Arc<dyn Fn(&'static str) + Send + Sync>;

pub(crate) fn emit_diagnostic(sink: Option<&DiagnosticSink>, event: &'static str) {
    if let Some(sink) = sink {
        sink(event);
    } else {
        report_diagnostic(event);
    }
}

#[derive(Deserialize)]
struct Challenge {
    device_id: String,
    nonce: String,
}

/// Existing Worker hibernation heartbeat contract (60s request, 20s deadline).
#[derive(Debug, Clone, Copy)]
pub struct HeartbeatTiming {
    pub interval: Duration,
    pub timeout: Duration,
    pub auth_interval: Duration,
}

impl Default for HeartbeatTiming {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(60),
            timeout: Duration::from_secs(20),
            auth_interval: Duration::from_secs(900),
        }
    }
}

/// Owner revocation cleanup is confirmed only after the actual runtime has
/// verified all owned processes have stopped. A non-executing transport cannot
/// make that claim, so its default response is always Uncertain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupStatus {
    Confirmed,
    Uncertain,
}

impl CleanupStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Uncertain => "uncertain",
        }
    }
}

/// A connection-scoped revocation signal. Executors must check this before
/// starting a side effect and at cancellable boundaries while work is in flight.
/// A revoked lease does not imply the underlying OS operation was rolled back:
/// interrupted or unknown operations require normal idempotent receipt recovery.
#[derive(Clone, Debug)]
pub struct ExecutionLease {
    live: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl ExecutionLease {
    fn new(stop: &Arc<AtomicBool>) -> Self {
        Self {
            live: Arc::new(AtomicBool::new(true)),
            stop: Arc::clone(stop),
        }
    }

    pub fn is_active(&self) -> bool {
        self.live.load(Ordering::Acquire) && !self.stop.load(Ordering::Acquire)
    }

    fn revoke(&self) {
        self.live.store(false, Ordering::Release);
    }

    pub(crate) fn same_incarnation(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.live, &other.live)
    }

    pub(crate) fn response(&self, frame: String) -> ExecutionResponse {
        ExecutionResponse {
            frame,
            lease: self.clone(),
        }
    }
}

/// An operation may only begin while its connection lease remains active.
/// The executor must additionally use the lease to cancel in-flight work.
#[derive(Debug)]
pub struct ExecutionRequest {
    frame: String,
    lease: ExecutionLease,
    reply_deadline: Instant,
}

impl ExecutionRequest {
    pub fn frame_if_active(&self) -> Option<&str> {
        self.lease.is_active().then_some(self.frame.as_str())
    }

    pub fn lease(&self) -> &ExecutionLease {
        &self.lease
    }

    // The Worker waits five seconds, including time already spent in the
    // queue. Leave one second for transport and mandatory OS/receipt work.
    // This is an optional-result-wait budget, not a guarantee of IO latency.
    pub(crate) fn reply_deadline(&self) -> Instant {
        self.reply_deadline
    }
    pub fn response(&self, frame: String) -> ExecutionResponse {
        ExecutionResponse {
            frame,
            lease: self.lease.clone(),
        }
    }
}

/// A response is bound to the WebSocket incarnation that accepted the request;
/// stale responses cannot be replayed on a replacement connection.
#[derive(Debug)]
pub struct ExecutionResponse {
    frame: String,
    lease: ExecutionLease,
}

/// Dedicated bounded queue item for Secure Input. It never enters the
/// generic operation request queue or receipt/digest path.
pub struct SecureInputRequest {
    command: crate::secure_input::SecureInputCommand,
    lease: ExecutionLease,
}

impl SecureInputRequest {
    fn new(command: crate::secure_input::SecureInputCommand, lease: ExecutionLease) -> Self {
        Self { command, lease }
    }

    pub(crate) fn command_mut(&mut self) -> &mut crate::secure_input::SecureInputCommand {
        &mut self.command
    }
    pub(crate) fn lease(&self) -> &ExecutionLease {
        &self.lease
    }
}

pub struct AuthenticatedSocket {
    pub device_id: String,
    runtime: Arc<Runtime>,
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    timing: HeartbeatTiming,
    last_ping: Instant,
    awaiting_pong: Option<Instant>,
    last_auth_probe_sent: Instant,
    awaiting_auth: Option<(String, Instant)>,
}

impl AuthenticatedSocket {
    /// Default timing is the existing Node Agent's 60s/20s contract. Tests may
    /// choose shorter timing against a disposable loopback Worker.
    pub fn set_heartbeat_timing(&mut self, timing: HeartbeatTiming) -> Result<(), SessionError> {
        if timing.timeout.is_zero()
            || timing.interval <= timing.timeout
            || timing.auth_interval <= timing.timeout
        {
            return Err(SessionError::Protocol);
        }
        self.timing = timing;
        self.last_ping = Instant::now();
        self.awaiting_pong = None;
        self.last_auth_probe_sent = Instant::now();
        self.awaiting_auth = None;
        Ok(())
    }

    // Single owner of the WSS state. A timed-out write ends the connection;
    // a partly written frame must never be retried on the same socket.
    async fn send_message(&mut self, message: Message) -> Result<(), SessionError> {
        tokio::time::timeout(Duration::from_secs(10), self.socket.send(message))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "WSS write deadline"))??;
        Ok(())
    }

    async fn send_text_async(&mut self, frame: &str) -> Result<(), SessionError> {
        if frame.len() > 65_536 {
            return Err(SessionError::Protocol);
        }
        self.send_message(Message::Text(frame.into())).await
    }

    pub fn send_text(&mut self, frame: &str) -> Result<(), SessionError> {
        let runtime = Arc::clone(&self.runtime);
        runtime.block_on(self.send_text_async(frame))
    }

    // Only the external atomic Stop needs periodic observation. Network and
    // completed replies wake the reactor immediately; no active read polling.
    fn next_deadline(&self) -> Instant {
        let ping = self
            .awaiting_pong
            .map_or(self.last_ping + self.timing.interval, |since| {
                since + self.timing.timeout
            });
        let auth = self.awaiting_auth.as_ref().map_or(
            self.last_auth_probe_sent + self.timing.auth_interval,
            |(_, since)| *since + self.timing.timeout,
        );
        ping.min(auth).min(Instant::now() + Duration::from_secs(1))
    }

    async fn advance_liveness(&mut self) -> Result<(), SessionError> {
        let now = Instant::now();
        if self
            .awaiting_pong
            .is_some_and(|since| now.duration_since(since) >= self.timing.timeout)
        {
            return Err(SessionError::HeartbeatTimeout);
        }
        if self
            .awaiting_auth
            .as_ref()
            .is_some_and(|(_, since)| now.duration_since(*since) >= self.timing.timeout)
        {
            return Err(SessionError::AuthorizationTimeout);
        }
        if self.awaiting_pong.is_none()
            && now.duration_since(self.last_ping) >= self.timing.interval
        {
            self.send_text_async("rc-v2:ping").await?;
            self.awaiting_pong = Some(now);
            self.last_ping = now;
        }
        if self.awaiting_auth.is_none()
            && now.duration_since(self.last_auth_probe_sent) >= self.timing.auth_interval
        {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| SessionError::Entropy)?;
            let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            self.send_text_async(&format!("rc-v2:auth:{nonce}")).await?;
            self.awaiting_auth = Some((nonce, now));
            self.last_auth_probe_sent = now;
        }
        Ok(())
    }

    async fn process_frame(
        &mut self,
        frame: Option<Result<Message, tungstenite::Error>>,
    ) -> Result<Option<String>, SessionError> {
        match frame.ok_or(SessionError::Ws(tungstenite::Error::ConnectionClosed))? {
            Ok(tungstenite::Message::Text(frame)) if frame == "rc-v2:pong" => {
                // An unsolicited or duplicated pong is not admission.
                if self.awaiting_pong.is_some() {
                    self.awaiting_pong = None;
                }
            }
            Ok(tungstenite::Message::Text(frame)) if frame.starts_with("rc-v2:auth-ok:") => {
                // Stale/duplicate ACKs never satisfy a newer nonce.
                if self
                    .awaiting_auth
                    .as_ref()
                    .is_some_and(|(nonce, _)| frame.as_str() == format!("rc-v2:auth-ok:{nonce}"))
                {
                    self.awaiting_auth = None;
                }
            }
            Ok(tungstenite::Message::Text(frame)) if frame.len() <= 65_536 => {
                return Ok(Some(frame.to_string()));
            }
            // Tungstenite queues the matching transport-level pong.
            Ok(Message::Ping(_)) => {
                tokio::time::timeout(Duration::from_secs(10), self.socket.flush())
                    .await
                    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "WSS pong deadline"))??;
            }
            Ok(Message::Pong(_)) => {}
            Ok(tungstenite::Message::Close(Some(frame)))
                if frame.code == tungstenite::protocol::frame::coding::CloseCode::Policy =>
            {
                return Err(SessionError::Policy);
            }
            Ok(tungstenite::Message::Close(Some(frame)))
                if frame.code == tungstenite::protocol::frame::coding::CloseCode::Normal
                    && frame.reason == "superseded" =>
            {
                return Err(SessionError::Superseded);
            }
            Ok(tungstenite::Message::Close(_)) => {
                return Err(SessionError::Ws(tungstenite::Error::ConnectionClosed));
            }
            Err(tungstenite::Error::Io(ref e))
                if matches!(
                    e.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) => {}
            Err(error) => return Err(SessionError::Ws(error)),
            _ => {
                return Err(SessionError::Protocol);
            }
        }
        Ok(None)
    }

    /// Compatibility helper for the one-shot Gate 0 probe.
    pub fn receive_text(&mut self) -> Result<String, SessionError> {
        let runtime = Arc::clone(&self.runtime);
        runtime.block_on(async {
            loop {
                self.advance_liveness().await?;
                let deadline = self.next_deadline();
                tokio::select! {
                    frame = self.socket.next() => {
                        if let Some(text) = self.process_frame(frame).await? {
                            return Ok(text);
                        }
                    }
                    _ = tokio::time::sleep_until(deadline.into()) => {}
                }
            }
        })
    }

    /// Liveness continues while the executor works. Each pump creates a new
    /// lease, invalidated on *every* exit (policy close, timeout, stop, queue
    /// overflow, or I/O error). Queued requests then refuse new execution.
    /// In-flight mutations must cooperatively abort and reconcile Unknown
    /// outcomes via the operation receipt protocol, not blindly retry them.
    pub fn pump(
        &mut self,
        stop: &Arc<AtomicBool>,
        incoming: &SyncSender<ExecutionRequest>,
        outgoing: &mut Receiver<ExecutionResponse>,
    ) -> Result<(), SessionError> {
        // The transport has no verified process ownership or cleanup ability.
        self.pump_with_cleanup(stop, incoming, outgoing, || CleanupStatus::Uncertain)
    }

    /// A strict read-only candidate pump. No operation frame or unrecognized
    /// payload may enter the executor queue; violations close with policy 1008.
    pub fn pump_native_read(
        &mut self,
        stop: &Arc<AtomicBool>,
        incoming: &SyncSender<ExecutionRequest>,
        outgoing: &mut Receiver<ExecutionResponse>,
    ) -> Result<(), SessionError> {
        let lease = ExecutionLease::new(stop);
        let result = self.pump_scoped(
            stop,
            incoming,
            outgoing,
            &lease,
            || CleanupStatus::Uncertain,
            FramePolicy::ReadOnly,
        );
        lease.revoke();
        result
    }

    /// Strict file candidate: admit only native reads, bounded file mutations
    /// and receipt queries. Unexpected frames close 1008 before queueing.
    pub fn pump_native_file(
        &mut self,
        stop: &Arc<AtomicBool>,
        incoming: &SyncSender<ExecutionRequest>,
        outgoing: &mut Receiver<ExecutionResponse>,
    ) -> Result<(), SessionError> {
        let lease = ExecutionLease::new(stop);
        let result = self.pump_scoped(
            stop,
            incoming,
            outgoing,
            &lease,
            || CleanupStatus::Uncertain,
            FramePolicy::NativeFiles,
        );
        lease.revoke();
        result
    }

    /// Managed process+file candidate. Owner cleanup closes native process
    /// admission and reports Confirmed only after each owned OS process has
    /// independently reached a confirmed state inside the Worker's ACK budget.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub fn pump_native_managed(
        &mut self,
        stop: &Arc<AtomicBool>,
        incoming: &SyncSender<ExecutionRequest>,
        outgoing: &mut Receiver<ExecutionResponse>,
        managed: &Arc<ManagedSessions>,
        secure_input: &SyncSender<SecureInputRequest>,
    ) -> Result<(), SessionError> {
        let lease = ExecutionLease::new(stop);
        let result = self.pump_scoped(
            stop,
            incoming,
            outgoing,
            &lease,
            || match managed.stop_all(Duration::from_millis(1_800)) {
                CleanupState::Confirmed => CleanupStatus::Confirmed,
                CleanupState::Unknown => CleanupStatus::Uncertain,
            },
            FramePolicy::NativeManaged {
                managed: Arc::clone(managed),
                secure_input: secure_input.clone(),
            },
        );
        lease.revoke();
        result
    }

    /// The caller may report Confirmed only after aborting and verifying every
    /// owned process. Bound cleanup to the Worker's 2.5s ACK window. Regardless
    /// of callback outcome, ordinary queued work was revoked first.
    pub fn pump_with_cleanup<F: FnOnce() -> CleanupStatus>(
        &mut self,
        stop: &Arc<AtomicBool>,
        incoming: &SyncSender<ExecutionRequest>,
        outgoing: &mut Receiver<ExecutionResponse>,
        cleanup: F,
    ) -> Result<(), SessionError> {
        let lease = ExecutionLease::new(stop);
        let result = self.pump_scoped(stop, incoming, outgoing, &lease, cleanup, FramePolicy::Any);
        lease.revoke();
        result
    }

    fn pump_scoped<F: FnOnce() -> CleanupStatus>(
        &mut self,
        stop: &Arc<AtomicBool>,
        incoming: &SyncSender<ExecutionRequest>,
        outgoing: &mut Receiver<ExecutionResponse>,
        lease: &ExecutionLease,
        cleanup: F,
        policy: FramePolicy,
    ) -> Result<(), SessionError> {
        let runtime = Arc::clone(&self.runtime);
        runtime.block_on(async {
            while !stop.load(Ordering::Acquire) {
                self.advance_liveness().await?;
                let deadline = self.next_deadline();
                let frame = tokio::select! {
                    frame = self.socket.next() => {
                        if stop.load(Ordering::Acquire) { return Ok(()); }
                        match self.process_frame(frame).await {
                            Ok(frame) => frame,
                            Err(_) if stop.load(Ordering::Acquire) => return Ok(()),
                            Err(error) => return Err(error),
                        }
                    }
                    reply = outgoing.recv(), if !outgoing.is_closed() || !outgoing.is_empty() => {
                        if let Some(reply) = reply {
                            if reply.lease.same_incarnation(lease) && reply.lease.is_active() {
                                self.send_text_async(&reply.frame).await?;
                            }
                        }
                        continue;
                    }
                    _ = tokio::time::sleep_until(deadline.into()) => continue,
                };
                if stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                if let Some(mut frame) = frame {
                    if let Some(request_id) = revocation_request_id(&frame)? {
                        lease.revoke(); // Abort queued and in-flight operations before cleanup.
                        let status = cleanup();
                        // Even if the socket died while cleanup ran, revocation is
                        // permanent. The Worker will honestly report unconfirmed.
                        let frame = json!({"kind":"revoke_cleanup_result","request_id":request_id,
                            "status":status.as_str()})
                        .to_string();
                        // Cleanup has a 1.8s budget; never wait the normal write
                        // deadline for an acknowledgement on a broken socket.
                        let _ = tokio::time::timeout(
                            Duration::from_millis(500),
                            self.send_text_async(&frame),
                        )
                        .await;
                        return Err(SessionError::Policy);
                    }
                    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
                    if let FramePolicy::NativeManaged { secure_input, .. } = &policy {
                        let kind = serde_json::from_str::<Value>(&frame)
                            .ok()
                            .and_then(|value| {
                                value.get("kind").and_then(Value::as_str).map(str::to_owned)
                            });
                        if matches!(
                            kind.as_deref(),
                            Some("secure_input_prepare" | "secure_input")
                        ) {
                            let parsed = crate::secure_input::parse_command(&frame);
                            frame.zeroize();
                            let command = parsed
                                .map_err(|_| SessionError::Protocol)?
                                .ok_or(SessionError::Protocol)?;
                            secure_input
                                .try_send(SecureInputRequest::new(command, lease.clone()))
                                .map_err(|_| SessionError::Queue)?;
                            continue;
                        }
                    }
                    let permitted = match &policy {
                        FramePolicy::Any => true,
                        FramePolicy::ReadOnly => parse_read_frame(&frame).is_ok(),
                        FramePolicy::NativeFiles => {
                            crate::native_file::parse_native_file_frame(&frame).is_ok()
                        }
                        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
                        FramePolicy::NativeManaged { .. } => {
                            crate::native_file::parse_native_managed_frame(&frame).is_ok()
                        }
                    };
                    if !permitted {
                        // A signed connection is not an authorization to interpret
                        // unexpected traffic. Keep failure scoped to this socket.
                        let _ = self
                            .send_message(Message::Close(Some(CloseFrame {
                                code: CloseCode::Policy,
                                reason: "invalid native operation".into(),
                            })))
                            .await;
                        return Err(SessionError::Policy);
                    }
                    incoming
                        .try_send(ExecutionRequest {
                            frame,
                            lease: lease.clone(),
                            reply_deadline: Instant::now() + Duration::from_secs(4),
                        })
                        .map_err(|_| SessionError::Queue)?;
                }
            }
            Ok(())
        })
    }
}

/// A malformed Owner cleanup request is never eligible for operation dispatch.
fn revocation_request_id(frame: &str) -> Result<Option<String>, SessionError> {
    let Ok(value) = serde_json::from_str::<Value>(frame) else {
        return Ok(None);
    };
    if value.get("kind").and_then(Value::as_str) != Some("revoke_cleanup") {
        return Ok(None);
    }
    let object = value.as_object().ok_or(SessionError::Protocol)?;
    if object.len() != 2 {
        return Err(SessionError::Protocol);
    }
    let request_id = object
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or(SessionError::Protocol)?;
    if !valid_device_id(request_id) {
        return Err(SessionError::Protocol);
    }
    Ok(Some(request_id.to_owned()))
}

/// Only network/liveness faults are retryable. In particular, 401/403/404,
/// 1008, invalid signed protocol, stale executor queues and malformed state
/// must not silently turn into repeated fresh admission attempts.
fn retryable(error: &SessionError) -> bool {
    match error {
        SessionError::Http(_)
        | SessionError::Io(_)
        | SessionError::Unavailable(_)
        | SessionError::HeartbeatTimeout
        | SessionError::AuthorizationTimeout => true,
        SessionError::Ws(
            tungstenite::Error::Io(_)
            | tungstenite::Error::ConnectionClosed
            | tungstenite::Error::AlreadyClosed
            // A lost transport may have no close handshake (Node close 1006).
            // Other WebSocket protocol violations remain nonretryable.
            | tungstenite::Error::Protocol(
                tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
            ),
        ) => true,
        SessionError::Ws(tungstenite::Error::Http(response)) => {
            [408, 425, 429].contains(&response.status().as_u16())
                || response.status().as_u16() >= 500
        }
        _ => false,
    }
}

#[derive(Default)]
struct ReconnectBackoff {
    failures: u32,
}

impl ReconnectBackoff {
    fn next_delay(&mut self, elapsed: Option<Duration>, heartbeat: Duration) -> Duration {
        // A brief successful handshake cannot reset the escalation window.
        // Match the Node Agent: two healthy heartbeat periods reset backoff.
        if elapsed.is_some_and(|duration| duration >= heartbeat.saturating_mul(2)) {
            self.failures = 0;
        }
        let delay = Duration::from_secs((1u64 << self.failures.min(5)).min(30));
        self.failures = self.failures.saturating_add(1);
        delay
    }
}

fn wait_or_stop(duration: Duration, stop: &AtomicBool) {
    let deadline = Instant::now() + duration;
    while !stop.load(Ordering::Acquire) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        std::thread::sleep(remaining.min(Duration::from_millis(100)));
    }
}

/// A nonproduction transport lifetime. Every reconnect starts a NEW HTTP
/// challenge and signed WSS proof, and pump creates a fresh execution lease.
/// This function intentionally does not create an operation executor or reuse
/// previous execution work. A stop or superseding socket ends gracefully;
/// owner policy or incompatible protocol ends permanently.
enum FramePolicy {
    Any,
    ReadOnly,
    NativeFiles,
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    NativeManaged {
        managed: Arc<ManagedSessions>,
        secure_input: SyncSender<SecureInputRequest>,
    },
}

struct TransportMode {
    receipt_health: Option<Arc<AtomicBool>>,
    timing: HeartbeatTiming,
    policy: FramePolicy,
    on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
    on_disconnected: Option<Arc<dyn Fn() + Send + Sync>>,
    on_diagnostic: Option<DiagnosticSink>,
}

pub fn maintain_authenticated_transport(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    stop: &Arc<AtomicBool>,
    incoming: &SyncSender<ExecutionRequest>,
    outgoing: &mut Receiver<ExecutionResponse>,
    timing: HeartbeatTiming,
) -> Result<(), SessionError> {
    maintain_transport_mode(
        endpoint,
        private_pem,
        device_id,
        stop,
        incoming,
        outgoing,
        TransportMode {
            receipt_health: None,
            timing,
            policy: FramePolicy::Any,
            on_connected: None,
            on_disconnected: None,
            on_diagnostic: None,
        },
    )
}

/// Native read-only WSS transport, with strict frame validation before the
/// executor receives any request. The full Agent is not yet implemented.
pub fn maintain_native_read_transport(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    stop: &Arc<AtomicBool>,
    incoming: &SyncSender<ExecutionRequest>,
    outgoing: &mut Receiver<ExecutionResponse>,
    timing: HeartbeatTiming,
) -> Result<(), SessionError> {
    maintain_transport_mode(
        endpoint,
        private_pem,
        device_id,
        stop,
        incoming,
        outgoing,
        TransportMode {
            receipt_health: None,
            timing,
            policy: FramePolicy::ReadOnly,
            on_connected: None,
            on_disconnected: None,
            on_diagnostic: None,
        },
    )
}

/// The non-installable native file executor shares the signed WSS and Grant
/// transport, but rejects every unimplemented operation before queueing.
pub fn maintain_native_file_transport(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    stop: &Arc<AtomicBool>,
    incoming: &SyncSender<ExecutionRequest>,
    outgoing: &mut Receiver<ExecutionResponse>,
    timing: HeartbeatTiming,
) -> Result<(), SessionError> {
    maintain_transport_mode(
        endpoint,
        private_pem,
        device_id,
        stop,
        incoming,
        outgoing,
        TransportMode {
            receipt_health: None,
            timing,
            policy: FramePolicy::NativeFiles,
            on_connected: None,
            on_disconnected: None,
            on_diagnostic: None,
        },
    )
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub struct ManagedTransportConfig {
    pub receipt_health: Arc<AtomicBool>,
    pub timing: HeartbeatTiming,
    pub managed: Arc<ManagedSessions>,
    pub secure_input: SyncSender<SecureInputRequest>,
    pub on_connected: Option<Arc<dyn Fn() + Send + Sync>>,
    pub on_disconnected: Option<Arc<dyn Fn() + Send + Sync>>,
    pub on_diagnostic: Option<DiagnosticSink>,
}

#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub fn maintain_native_managed_transport(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    stop: &Arc<AtomicBool>,
    incoming: &SyncSender<ExecutionRequest>,
    outgoing: &mut Receiver<ExecutionResponse>,
    config: ManagedTransportConfig,
) -> Result<(), SessionError> {
    maintain_transport_mode(
        endpoint,
        private_pem,
        device_id,
        stop,
        incoming,
        outgoing,
        TransportMode {
            receipt_health: Some(config.receipt_health),
            timing: config.timing,
            policy: FramePolicy::NativeManaged {
                managed: config.managed,
                secure_input: config.secure_input,
            },
            on_connected: config.on_connected,
            on_disconnected: config.on_disconnected,
            on_diagnostic: config.on_diagnostic,
        },
    )
}

fn maintain_transport_mode(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    stop: &Arc<AtomicBool>,
    incoming: &SyncSender<ExecutionRequest>,
    outgoing: &mut Receiver<ExecutionResponse>,
    mode: TransportMode,
) -> Result<(), SessionError> {
    let mut backoff = ReconnectBackoff::default();
    let mut last_event = None;
    let mut report = |error: &SessionError, reset: bool| {
        let event = error.diagnostic_event();
        if reset || last_event != Some(event) {
            emit_diagnostic(mode.on_diagnostic.as_ref(), event);
        }
        last_event = Some(event);
    };
    while !stop.load(Ordering::Acquire) {
        let elapsed = match connect_authenticated(endpoint, private_pem, device_id) {
            Ok(mut socket) => {
                socket.set_heartbeat_timing(mode.timing)?;
                let connected_at = Instant::now();
                let pump = (|| {
                    if stop.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    if let Some(health) = mode.receipt_health.as_ref() {
                        let info = crate::device_info::DeviceInfo::collect();
                        socket.send_text(&info.frame(health.load(Ordering::Acquire)))?;
                    }
                    if let Some(on_connected) = mode.on_connected.as_ref() {
                        on_connected();
                    }
                    let result = match &mode.policy {
                        FramePolicy::Any => socket.pump(stop, incoming, outgoing),
                        FramePolicy::ReadOnly => socket.pump_native_read(stop, incoming, outgoing),
                        FramePolicy::NativeFiles => {
                            socket.pump_native_file(stop, incoming, outgoing)
                        }
                        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
                        FramePolicy::NativeManaged {
                            managed,
                            secure_input,
                        } => socket.pump_native_managed(
                            stop,
                            incoming,
                            outgoing,
                            managed,
                            secure_input,
                        ),
                    };
                    if let Some(on_disconnected) = mode.on_disconnected.as_ref() {
                        on_disconnected();
                    }
                    result
                })();
                match pump {
                    Ok(()) => return Ok(()),
                    Err(error) => {
                        report(&error, true);
                        if matches!(error, SessionError::Superseded) {
                            return Ok(());
                        }
                        if !retryable(&error) {
                            return Err(error);
                        }
                    }
                }
                Some(connected_at.elapsed())
            }
            Err(error) => {
                report(&error, false);
                if !retryable(&error) {
                    return Err(error);
                }
                None
            }
        };
        if stop.load(Ordering::Acquire) {
            break;
        }
        wait_or_stop(backoff.next_delay(elapsed, mode.timing.interval), stop);
    }
    Ok(())
}

fn trusted_endpoint(address: &str) -> Result<Url, SessionError> {
    let url = Url::parse(address).map_err(|_| SessionError::Endpoint)?;
    let local =
        url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some();
    if !local && url.scheme() != "https" {
        return Err(SessionError::Endpoint);
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(SessionError::Endpoint);
    }
    Ok(url)
}

/// Claim a fresh signed nonce for an already-approved local identity, then
/// verify the Worker actually selects the noncredential `rc-v2` subprotocol.
/// Any 401/403/404 remains a permanent identity rejection (not retry admission).
pub fn connect_authenticated(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
) -> Result<AuthenticatedSocket, SessionError> {
    let origin = trusted_endpoint(endpoint)?;
    if !valid_device_id(device_id) {
        return Err(SessionError::Challenge);
    }
    let post = origin
        .join("/agent/session/challenge")
        .map_err(|_| SessionError::Endpoint)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(Policy::none())
        .build()?;
    let mut response = client
        .post(post)
        .json(&json!({ "device_id": device_id }))
        .send()?;
    let status = response.status().as_u16();
    if [401, 403, 404].contains(&status) {
        return Err(SessionError::Rejected(status));
    }
    if [408, 425, 429].contains(&status) || status >= 500 {
        return Err(SessionError::Unavailable(status));
    }
    if status != 200 {
        return Err(SessionError::Challenge);
    }
    // Never allocate an unbounded response from a remote authorization endpoint.
    let mut body = Vec::new();
    response
        .by_ref()
        .take(16_385)
        .read_to_end(&mut body)
        .map_err(|_| SessionError::Challenge)?;
    if body.len() > 16_384 {
        return Err(SessionError::Challenge);
    }
    let challenged: Challenge =
        serde_json::from_slice(&body).map_err(|_| SessionError::Challenge)?;
    if challenged.device_id != device_id {
        return Err(SessionError::Challenge);
    }
    let proof = signed_session_proof(private_pem, device_id, &challenged.nonce)
        .map_err(|_| SessionError::Challenge)?;
    let mut ws_url = origin
        .join(&format!("/agent/connect/{device_id}"))
        .map_err(|_| SessionError::Endpoint)?;
    ws_url
        .set_scheme(if origin.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| SessionError::Endpoint)?;
    let mut request = ws_url.as_str().into_client_request()?;
    let protocols = format!("rc-v2, rcv2.{}.{}", challenged.nonce, proof.proof);
    request.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        protocols.parse().map_err(|_| SessionError::Protocol)?,
    );
    let mut config = WebSocketConfig::default();
    config.read_buffer_size = 8_192;
    config.write_buffer_size = 8_192;
    config.max_write_buffer_size = 73_728;
    config.max_message_size = Some(65_536);
    config.max_frame_size = Some(65_536);
    // Resolve and connect explicitly so a stalled TCP dial or TLS/WS upgrade
    // cannot wait forever. Do not follow redirects with a signed proof.
    let host = origin.host_str().ok_or(SessionError::Endpoint)?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = origin
        .port_or_known_default()
        .ok_or(SessionError::Endpoint)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last_error = io::Error::new(io::ErrorKind::AddrNotAvailable, "no RCA address");
    let mut connected = None;
    for address in (host, port).to_socket_addrs()? {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(stream) => {
                connected = Some(stream);
                break;
            }
            Err(error) => last_error = error,
        }
    }
    let stream = connected.ok_or(SessionError::Io(last_error))?;
    stream.set_nodelay(true)?;
    stream.set_nonblocking(true)?;
    let runtime = Arc::new(
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?,
    );
    let (mut socket, response) = runtime.block_on(async {
        let stream = tokio::net::TcpStream::from_std(stream)?;
        tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::client_async_tls_with_config(request, stream, Some(config), None),
        )
        .await
        .map_err(|_| {
            SessionError::Io(io::Error::new(
                io::ErrorKind::TimedOut,
                "WSS handshake deadline",
            ))
        })?
        .map_err(|error| match error {
            tungstenite::Error::Http(response)
                if [401, 403, 404].contains(&response.status().as_u16()) =>
            {
                SessionError::Rejected(response.status().as_u16())
            }
            error => SessionError::Ws(error),
        })
    })?;
    if response
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        != Some("rc-v2")
    {
        let _ = runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(1), socket.close(None)).await
        });
        return Err(SessionError::Protocol);
    }
    let authenticated = AuthenticatedSocket {
        runtime,
        device_id: device_id.to_owned(),
        socket,
        timing: HeartbeatTiming::default(),
        last_ping: Instant::now(),
        awaiting_pong: None,
        last_auth_probe_sent: Instant::now(),
        awaiting_auth: None,
    };
    Ok(authenticated)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_urls_rejected_before_any_network_or_identity_effect() {
        for url in [
            "http://example.com/",
            "http://localhost:3000/",
            "http://127.0.0.1/",
            "https://example.com/path",
            "https://user:pass@example.com/",
            "https://example.com/?ticket=x",
            "file:///tmp/a",
        ] {
            assert!(trusted_endpoint(url).is_err(), "{url}");
        }
        assert!(trusted_endpoint("https://mcp.example.org/").is_ok());
        assert!(trusted_endpoint("http://127.0.0.1:3000/").is_ok());
    }

    #[test]
    fn reconnect_uses_capped_backoff_until_two_healthy_heartbeat_periods() {
        let mut retry = ReconnectBackoff::default();
        let short = Some(Duration::from_millis(20));
        let delays = (0..7)
            .map(|_| retry.next_delay(short, Duration::from_secs(60)).as_secs())
            .collect::<Vec<_>>();
        assert_eq!(delays, [1, 2, 4, 8, 16, 30, 30]);
        assert_eq!(
            retry.next_delay(Some(Duration::from_secs(120)), Duration::from_secs(60)),
            Duration::from_secs(1)
        );
    }

    #[test]
    fn permanent_rejections_never_enter_retry_and_stop_interrupts_delay() {
        for error in [
            SessionError::Rejected(401),
            SessionError::Policy,
            SessionError::Superseded,
            SessionError::Protocol,
            SessionError::Queue,
            SessionError::Ws(tungstenite::Error::Protocol(
                tungstenite::error::ProtocolError::InvalidOpcode(3),
            )),
        ] {
            assert!(!retryable(&error), "{error}");
        }
        assert!(retryable(&SessionError::Ws(tungstenite::Error::Protocol(
            tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
        ))));
        for code in [408, 425, 429, 503] {
            assert!(retryable(&SessionError::Unavailable(code)));
            let response = tungstenite::http::Response::builder()
                .status(code)
                .body(None)
                .unwrap();
            assert!(retryable(&SessionError::Ws(tungstenite::Error::Http(
                Box::new(response)
            ))));
        }
        let stop = AtomicBool::new(true);
        let before = Instant::now();
        wait_or_stop(Duration::from_secs(30), &stop);
        assert!(before.elapsed() < Duration::from_secs(1));
    }
}
