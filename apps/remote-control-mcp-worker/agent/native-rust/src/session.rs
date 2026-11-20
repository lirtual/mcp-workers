//! Nonproduction signed WSS login against the existing RCA Worker interface.
//! No background reconnect, receive dispatch, or automatic owner grant is provided.
use crate::identity::{signed_session_proof, valid_device_id};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};
use thiserror::Error;
use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::HandshakeError;
use tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tungstenite::protocol::{WebSocket, WebSocketConfig};
use tungstenite::stream::MaybeTlsStream;
use url::Url;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("untrusted RCA endpoint")]
    Endpoint,
    #[error("Agent identity is not authorized (HTTP {0})")]
    Rejected(u16),
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
    #[error("RCA authorization nonce entropy unavailable")]
    Entropy,
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

    pub fn receive_text(&mut self) -> Result<String, SessionError> {
        loop {
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
                    if self.awaiting_auth.as_ref().is_some_and(|(nonce, _)| {
                        frame.as_str() == format!("rc-v2:auth-ok:{nonce}")
                    }) {
                        self.awaiting_auth = None;
                    }
                }
                Ok(tungstenite::Message::Text(frame)) if frame.len() <= 65_536 => {
                    return Ok(frame.to_string());
                }
                // Tungstenite queues a matching transport-level pong.
                Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_)) => {}
                Ok(tungstenite::Message::Close(Some(frame)))
                    if frame.code == tungstenite::protocol::frame::coding::CloseCode::Policy =>
                {
                    return Err(SessionError::Policy);
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
        }
    }
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
}
