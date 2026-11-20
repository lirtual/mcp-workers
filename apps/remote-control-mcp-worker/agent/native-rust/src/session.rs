//! Nonproduction signed WSS login against the existing RCA Worker interface.
//! No installed Agent lifecycle, local operation executor, or automatic Owner Grant is provided.
use crate::identity::{signed_session_proof, valid_device_id};
use crate::native_read::parse_read_frame;
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::HandshakeError;
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{CloseFrame, WebSocket, WebSocketConfig};
use tungstenite::stream::MaybeTlsStream;
use url::Url;

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

    fn same_incarnation(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.live, &other.live)
    }
}

/// An operation may only begin while its connection lease remains active.
/// The executor must additionally use the lease to cancel in-flight work.
#[derive(Debug)]
pub struct ExecutionRequest {
    frame: String,
    lease: ExecutionLease,
}

impl ExecutionRequest {
    pub fn frame_if_active(&self) -> Option<&str> {
        self.lease.is_active().then_some(self.frame.as_str())
    }

    pub fn lease(&self) -> &ExecutionLease {
        &self.lease
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

pub struct AuthenticatedSocket {
    pub device_id: String,
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
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
        self.configure_read_poll()
    }

    fn configure_read_poll(&mut self) -> Result<(), SessionError> {
        let timeout = self
            .timing
            .timeout
            .min(Duration::from_secs(1))
            .max(Duration::from_millis(20));
        // A successful TLS/WS handshake has a 10s dial timeout; persistent
        // sockets instead poll for liveness without treating idle as failure.
        match self.socket.get_mut() {
            MaybeTlsStream::Plain(stream) => stream.set_read_timeout(Some(timeout))?,
            MaybeTlsStream::Rustls(stream) => stream.sock.set_read_timeout(Some(timeout))?,
            _ => return Err(SessionError::Protocol),
        }
        Ok(())
    }

    pub fn send_text(&mut self, frame: &str) -> Result<(), SessionError> {
        if frame.len() > 65_536 {
            return Err(SessionError::Protocol);
        }
        self.socket.send(tungstenite::Message::Text(frame.into()))?;
        Ok(())
    }

    /// One bounded socket read; liveness always advances even if a separate
    /// execution worker is busy. Callers may poll outbound responses between reads.
    pub fn poll_text(&mut self) -> Result<Option<String>, SessionError> {
        let now = Instant::now();
        if self
            .awaiting_pong
            .is_some_and(|since| now.duration_since(since) >= self.timing.timeout)
        {
            let _ = self.socket.close(None);
            return Err(SessionError::HeartbeatTimeout);
        }
        if self
            .awaiting_auth
            .as_ref()
            .is_some_and(|(_, since)| now.duration_since(*since) >= self.timing.timeout)
        {
            let _ = self.socket.close(None);
            return Err(SessionError::AuthorizationTimeout);
        }
        if self.awaiting_pong.is_none()
            && now.duration_since(self.last_ping) >= self.timing.interval
        {
            self.socket
                .send(tungstenite::Message::Text("rc-v2:ping".into()))?;
            self.awaiting_pong = Some(now);
            self.last_ping = now;
        }
        if self.awaiting_auth.is_none()
            && now.duration_since(self.last_auth_probe_sent) >= self.timing.auth_interval
        {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| SessionError::Entropy)?;
            let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            self.socket.send(tungstenite::Message::Text(
                format!("rc-v2:auth:{nonce}").into(),
            ))?;
            self.awaiting_auth = Some((nonce, now));
            self.last_auth_probe_sent = now;
        }
        match self.socket.read() {
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
            // Tungstenite queues a matching transport-level pong.
            Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_)) => {}
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
                let _ = self.socket.close(None);
                return Err(SessionError::Protocol);
            }
        }
        Ok(None)
    }

    /// Compatibility helper for the one-shot Gate 0 probe.
    pub fn receive_text(&mut self) -> Result<String, SessionError> {
        loop {
            if let Some(frame) = self.poll_text()? {
                return Ok(frame);
            }
        }
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
        outgoing: &Receiver<ExecutionResponse>,
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
        outgoing: &Receiver<ExecutionResponse>,
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

    /// Strict file candidate: admit only native reads, write_file and receipt
    /// queries. All unexpected frames close 1008 before execution queueing.
    pub fn pump_native_file(
        &mut self,
        stop: &Arc<AtomicBool>,
        incoming: &SyncSender<ExecutionRequest>,
        outgoing: &Receiver<ExecutionResponse>,
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

    /// The caller may report Confirmed only after aborting and verifying every
    /// owned process. Bound cleanup to the Worker's 2.5s ACK window. Regardless
    /// of callback outcome, ordinary queued work was revoked first.
    pub fn pump_with_cleanup<F: FnOnce() -> CleanupStatus>(
        &mut self,
        stop: &Arc<AtomicBool>,
        incoming: &SyncSender<ExecutionRequest>,
        outgoing: &Receiver<ExecutionResponse>,
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
        outgoing: &Receiver<ExecutionResponse>,
        lease: &ExecutionLease,
        cleanup: F,
        policy: FramePolicy,
    ) -> Result<(), SessionError> {
        while !stop.load(Ordering::Acquire) {
            for _ in 0..4 {
                match outgoing.try_recv() {
                    Ok(reply) if reply.lease.same_incarnation(lease) && reply.lease.is_active() => {
                        self.send_text(&reply.frame)?;
                    }
                    Ok(_) => {} // Discard results from a prior socket incarnation.
                    Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                }
            }
            let frame = match self.poll_text() {
                Ok(value) => value,
                Err(_) if stop.load(Ordering::Acquire) => return Ok(()),
                Err(error) => return Err(error),
            };
            // A local Stop may arrive while the blocking read is pending.
            // Prevent that frame from becoming executable after Stop.
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            if let Some(frame) = frame {
                if let Some(request_id) = revocation_request_id(&frame)? {
                    lease.revoke(); // Abort queued and in-flight operations before cleanup.
                    let status = cleanup();
                    // Even if the socket died while cleanup ran, revocation is
                    // permanent. The Worker will honestly report unconfirmed.
                    let _ = self.send_text(
                        &json!({"kind":"revoke_cleanup_result","request_id":request_id,
                            "status":status.as_str()})
                        .to_string(),
                    );
                    return Err(SessionError::Policy);
                }
                let permitted = match policy {
                    FramePolicy::Any => true,
                    FramePolicy::ReadOnly => parse_read_frame(&frame).is_ok(),
                    FramePolicy::NativeFiles => {
                        crate::native_file::parse_native_file_frame(&frame).is_ok()
                    }
                };
                if !permitted {
                    // A signed connection is not an authorization to interpret
                    // unexpected traffic. Keep failure scoped to this socket.
                    let _ = self.socket.close(Some(CloseFrame {
                        code: CloseCode::Policy,
                        reason: "invalid native operation".into(),
                    }));
                    return Err(SessionError::Policy);
                }
                incoming
                    .try_send(ExecutionRequest {
                        frame,
                        lease: lease.clone(),
                    })
                    .map_err(|_| SessionError::Queue)?;
            }
        }
        Ok(())
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
            | tungstenite::Error::AlreadyClosed,
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
#[derive(Clone, Copy)]
enum FramePolicy {
    Any,
    ReadOnly,
    NativeFiles,
}

#[derive(Clone, Copy)]
struct TransportMode {
    timing: HeartbeatTiming,
    policy: FramePolicy,
}

pub fn maintain_authenticated_transport(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    stop: &Arc<AtomicBool>,
    incoming: &SyncSender<ExecutionRequest>,
    outgoing: &Receiver<ExecutionResponse>,
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
            timing,
            policy: FramePolicy::Any,
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
    outgoing: &Receiver<ExecutionResponse>,
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
            timing,
            policy: FramePolicy::ReadOnly,
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
    outgoing: &Receiver<ExecutionResponse>,
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
            timing,
            policy: FramePolicy::NativeFiles,
        },
    )
}

fn maintain_transport_mode(
    endpoint: &str,
    private_pem: &str,
    device_id: &str,
    stop: &Arc<AtomicBool>,
    incoming: &SyncSender<ExecutionRequest>,
    outgoing: &Receiver<ExecutionResponse>,
    mode: TransportMode,
) -> Result<(), SessionError> {
    let mut backoff = ReconnectBackoff::default();
    while !stop.load(Ordering::Acquire) {
        let elapsed = match connect_authenticated(endpoint, private_pem, device_id) {
            Ok(mut socket) => {
                socket.set_heartbeat_timing(mode.timing)?;
                let connected_at = Instant::now();
                let pump = match mode.policy {
                    FramePolicy::Any => socket.pump(stop, incoming, outgoing),
                    FramePolicy::ReadOnly => socket.pump_native_read(stop, incoming, outgoing),
                    FramePolicy::NativeFiles => socket.pump_native_file(stop, incoming, outgoing),
                };
                match pump {
                    Ok(()) | Err(SessionError::Superseded) => return Ok(()),
                    Err(error) if !retryable(&error) => return Err(error),
                    Err(_) => {}
                }
                Some(connected_at.elapsed())
            }
            Err(error) if !retryable(&error) => return Err(error),
            Err(_) => None,
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
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let (mut socket, response) =
        tungstenite::client_tls_with_config(request, stream, Some(config), None).map_err(
            |error| match error {
                HandshakeError::Failure(tungstenite::Error::Http(response))
                    if [401, 403, 404].contains(&response.status().as_u16()) =>
                {
                    SessionError::Rejected(response.status().as_u16())
                }
                HandshakeError::Failure(failure) => SessionError::Ws(failure),
                HandshakeError::Interrupted(_) => SessionError::Protocol,
            },
        )?;
    if response
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        != Some("rc-v2")
    {
        let _ = socket.close(None);
        return Err(SessionError::Protocol);
    }
    let mut authenticated = AuthenticatedSocket {
        device_id: device_id.to_owned(),
        socket,
        timing: HeartbeatTiming::default(),
        last_ping: Instant::now(),
        awaiting_pong: None,
        last_auth_probe_sent: Instant::now(),
        awaiting_auth: None,
    };
    authenticated.configure_read_poll()?;
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
        ] {
            assert!(!retryable(&error), "{error}");
        }
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
