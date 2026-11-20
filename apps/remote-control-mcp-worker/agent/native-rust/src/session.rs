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
}

#[derive(Deserialize)]
struct Challenge {
    device_id: String,
    nonce: String,
}

pub struct AuthenticatedSocket {
    pub device_id: String,
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
}

impl AuthenticatedSocket {
    pub fn send_text(&mut self, frame: &str) -> Result<(), SessionError> {
        if frame.len() > 65_536 {
            return Err(SessionError::Protocol);
        }
        self.socket.send(tungstenite::Message::Text(frame.into()))?;
        Ok(())
    }

    pub fn receive_text(&mut self) -> Result<String, SessionError> {
        loop {
            match self.socket.read()? {
                tungstenite::Message::Text(frame) if frame.len() <= 65_536 => {
                    return Ok(frame.to_string());
                }
                // Tungstenite queues the matching pong. Control frames do not
                // terminate a valid Agent session or enter operation dispatch.
                tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_) => continue,
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
    Ok(AuthenticatedSocket {
        device_id: device_id.to_owned(),
        socket,
    })
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
