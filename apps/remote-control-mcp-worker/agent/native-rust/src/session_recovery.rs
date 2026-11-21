//! Signed verification of the newly registered GitHub Session identity.
//! The production entrypoint uses only the fixed RCA HTTPS origin. Tests use
//! an explicit loopback fixture; no installed device or production grant is touched.

use crate::identity::signed_session_proof;
use crate::session_enrollment::{validate_session_identity, SessionDeviceIdentity};
use crate::session_registration::{valid_session_transport_grant, RegisteredSessionDevice};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use url::Url;

const ORIGIN: &str = "https://rca.lirtual.dpdns.org/";
const BODY_LIMIT: usize = 1024;

#[derive(Debug, Error)]
pub enum SessionRecoveryError {
    #[error("invalid or expired GitHub Session identity/grant")]
    InvalidIdentity,
    #[error("signed Session recovery endpoint unavailable")]
    Unavailable,
    #[error("signed Session identity was not confirmed by the Worker")]
    Rejected,
}

fn post_bounded(
    client: &Client,
    origin: &Url,
    route: &str,
    body: Value,
) -> Result<Value, SessionRecoveryError> {
    let target = origin
        .join(route)
        .map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    let mut response = client
        .post(target)
        .header("cache-control", "no-store")
        .json(&body)
        .send()
        .map_err(|_| SessionRecoveryError::Unavailable)?;
    if response.status().as_u16() != 200
        || response
            .content_length()
            .is_some_and(|len| len > BODY_LIMIT as u64)
    {
        return Err(SessionRecoveryError::Rejected);
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take((BODY_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| SessionRecoveryError::Unavailable)?;
    if bytes.len() > BODY_LIMIT {
        return Err(SessionRecoveryError::Rejected);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| SessionRecoveryError::Rejected)?;
    if !value.is_object() {
        return Err(SessionRecoveryError::Rejected);
    }
    Ok(value)
}

fn verify_at_origin(
    identity: &SessionDeviceIdentity,
    registered: &RegisteredSessionDevice,
    origin: &Url,
) -> Result<(), SessionRecoveryError> {
    validate_session_identity(identity, &identity.attempt)
        .map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    let now_ms: u64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SessionRecoveryError::InvalidIdentity)?
        .as_millis()
        .try_into()
        .map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    if !valid_session_transport_grant(registered, now_ms) {
        return Err(SessionRecoveryError::InvalidIdentity);
    }

    // In production the origin is a compile-time constant. Test-only callers
    // may supply an IPv4 loopback server, never a remote HTTP endpoint.
    let local = origin.scheme() == "http"
        && origin.host_str() == Some("127.0.0.1")
        && origin.port().is_some();
    if !local && origin.as_str() != ORIGIN {
        return Err(SessionRecoveryError::InvalidIdentity);
    }
    if !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err(SessionRecoveryError::InvalidIdentity);
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| SessionRecoveryError::Unavailable)?;
    // The challenge is selected by THIS public key. A conflicting registered
    // device ID must fail before the proof is sent.
    let challenge = post_bounded(
        &client,
        origin,
        "/agent/session/challenge",
        json!({"public_key":identity.public_key}),
    )?;
    if challenge.get("device_id").and_then(Value::as_str) != Some(&registered.device_id) {
        return Err(SessionRecoveryError::Rejected);
    }
    let nonce = challenge
        .get("nonce")
        .and_then(Value::as_str)
        .ok_or(SessionRecoveryError::Rejected)?;
    let proof = signed_session_proof(&identity.private_key_pem, &registered.device_id, nonce)
        .map_err(|_| SessionRecoveryError::Rejected)?;
    if proof.public_key != identity.public_key {
        return Err(SessionRecoveryError::InvalidIdentity);
    }
    let recovered = post_bounded(
        &client,
        origin,
        "/agent/session/recover",
        json!({"device_id":registered.device_id,"nonce":nonce,"proof":proof.proof}),
    )?;
    if recovered.get("status").and_then(Value::as_str) != Some("verified")
        || recovered.get("device_id").and_then(Value::as_str) != Some(&registered.device_id)
    {
        return Err(SessionRecoveryError::Rejected);
    }
    Ok(())
}

/// Verify that a registered Session grant resolves to the exact Ed25519
/// identity for this physical Attempt before launching a credential-free child.
/// This makes NO new pairing request. Failure must prevent child activation.
pub fn verify_registered_session_device(
    identity: &SessionDeviceIdentity,
    registered: &RegisteredSessionDevice,
) -> Result<(), SessionRecoveryError> {
    let origin = Url::parse(ORIGIN).map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    verify_at_origin(identity, registered, &origin)
}

/// A registration parent must prove its exact device identity to the Worker
/// before launching any long-lived credential-free Linux Session child.
/// Only the fixed production origin is reachable from this public boundary.
#[cfg(target_os = "linux")]
#[derive(Debug, Error)]
pub enum SessionLaunchError {
    #[error(transparent)]
    Recovery(#[from] SessionRecoveryError),
    #[error(transparent)]
    Runner(#[from] crate::session_runner::SessionRunnerError),
}

#[cfg(target_os = "linux")]
fn recover_and_spawn_at_origin(
    identity: &SessionDeviceIdentity,
    registered: &RegisteredSessionDevice,
    origin: &Url,
    executable: &std::path::Path,
    source: &std::collections::BTreeMap<String, String>,
) -> Result<std::process::Child, SessionLaunchError> {
    let (attempt, _) = crate::session_runner::checked_runner_context(source)?;
    validate_session_identity(identity, &attempt)
        .map_err(|_| crate::session_runner::SessionRunnerError::IdentityMismatch)?;
    verify_at_origin(identity, registered, origin)?;
    // The launcher independently rechecks the expiry and exact Attempt at fork.
    Ok(crate::session_runner::spawn_credential_free_transport(
        executable, registered, identity, source,
    )?)
}

#[cfg(target_os = "linux")]
pub fn verify_and_spawn_session_transport(
    identity: &SessionDeviceIdentity,
    registered: &RegisteredSessionDevice,
    executable: &std::path::Path,
    source: &std::collections::BTreeMap<String, String>,
) -> Result<std::process::Child, SessionLaunchError> {
    let origin = Url::parse(ORIGIN).map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    recover_and_spawn_at_origin(identity, registered, &origin, executable, source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_enrollment::{new_session_identity, SessionPhysicalAttempt};
    use base64::{
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
        Engine,
    };
    use ed25519_dalek::pkcs8::DecodePublicKey;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    const DEVICE: &str = "123e4567-e89b-42d3-a456-426614174001";
    const NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAAAA";

    fn identity() -> SessionDeviceIdentity {
        new_session_identity(&SessionPhysicalAttempt {
            attempt_id: "123e4567-e89b-42d3-a456-426614174004".into(),
            github_run_id: 44931213131,
            github_run_attempt: 1,
            workflow_name: "ubuntu".into(),
        })
        .unwrap()
    }

    fn grant() -> RegisteredSessionDevice {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        RegisteredSessionDevice {
            device_id: DEVICE.into(),
            expires_at: now + 60_000,
        }
    }

    fn recv_request(stream: &mut TcpStream) -> (String, Value) {
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut chunk = [0_u8; 1024];
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0 && bytes.len() + count < 8192);
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let header = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
        let length: usize = header
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .and_then(|part| part.trim().parse().ok())
            })
            .unwrap();
        while bytes.len() < header_end + length {
            let mut chunk = [0_u8; 1024];
            let count = stream.read(&mut chunk).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
        (
            header.lines().next().unwrap().to_owned(),
            serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap(),
        )
    }

    fn reply(stream: &mut TcpStream, status: &str, body: Value) {
        let raw = body.to_string();
        write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{raw}",raw.len()).unwrap();
    }

    #[test]
    fn real_http_signed_recovery_verifies_the_registered_attempt_key() {
        let identity = identity();
        let granted = grant();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin = Url::parse(&format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        ))
        .unwrap();
        let expected_public = identity.public_key.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let (route, body) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/session/challenge HTTP/1.1");
            assert_eq!(body, json!({"public_key":expected_public}));
            reply(
                &mut socket,
                "200 OK",
                json!({"device_id":DEVICE,"nonce":NONCE}),
            );
            let (mut socket, _) = listener.accept().unwrap();
            let (route, body) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/session/recover HTTP/1.1");
            assert_eq!(body["device_id"], DEVICE);
            assert_eq!(body["nonce"], NONCE);
            let der = STANDARD.decode(expected_public).unwrap();
            let key = VerifyingKey::from_public_key_der(&der).unwrap();
            let signature = Signature::try_from(
                URL_SAFE_NO_PAD
                    .decode(body["proof"].as_str().unwrap())
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
            let transcript = format!(
                "remote-control:v2:session:{DEVICE}:{NONCE}:{}",
                body["device_id"]
                    .as_str()
                    .map(|_| STANDARD.encode(der))
                    .unwrap()
            );
            key.verify(transcript.as_bytes(), &signature).unwrap();
            reply(
                &mut socket,
                "200 OK",
                json!({"status":"verified","device_id":DEVICE}),
            );
        });
        #[cfg(not(target_os = "linux"))]
        verify_at_origin(&identity, &granted, &origin).unwrap();

        #[cfg(target_os = "linux")]
        {
            // The verified grant can now cross the #957 credential-free
            // launch boundary with the same identity and physical Attempt.
            use std::collections::BTreeMap;
            use std::fs;
            use std::os::unix::fs::PermissionsExt;
            let root = tempfile::tempdir().unwrap();
            let executable = root.path().join("child.sh");
            let marker = root.path().join("launched");
            fs::write(
                &executable,
                format!(
                    "#!/bin/sh\nprintf '%s\\n' \"$RUNNER_TRACKING_ID\" \"$GH_TOKEN\" > '{}'\n",
                    marker.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            let source: BTreeMap<String, String> = [
                ("GITHUB_ACTIONS", "true"),
                ("RUNNER_ENVIRONMENT", "github-hosted"),
                ("GITHUB_WORKFLOW", "ubuntu"),
                ("GITHUB_RUN_ID", "44931213131"),
                ("GITHUB_RUN_ATTEMPT", "1"),
                ("ATTEMPT_ID", "123e4567-e89b-42d3-a456-426614174004"),
                ("RUNNER_TEMP", "/tmp"),
                ("RUNNER_TRACKING_ID", "synthetic-job"),
                ("PATH", "/usr/bin:/bin"),
                ("GH_TOKEN", "must-not-leak"),
            ]
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
            let mut child =
                recover_and_spawn_at_origin(&identity, &granted, &origin, &executable, &source)
                    .unwrap();
            assert!(child.wait().unwrap().success());
            assert_eq!(fs::read_to_string(marker).unwrap(), "synthetic-job\n\n");
        }
        server.join().unwrap();
    }

    #[test]
    fn mismatched_or_expired_grant_fails_before_any_http() {
        let key = identity();
        let origin = Url::parse("http://127.0.0.1:9/").unwrap();
        let mut ticket = grant();
        ticket.device_id = "forged".into();
        assert!(matches!(
            verify_at_origin(&key, &ticket, &origin),
            Err(SessionRecoveryError::InvalidIdentity)
        ));
        ticket = grant();
        ticket.expires_at = 0;
        assert!(matches!(
            verify_at_origin(&key, &ticket, &origin),
            Err(SessionRecoveryError::InvalidIdentity)
        ));
        let other = new_session_identity(&key.attempt).unwrap();
        let mut tampered = key.clone();
        tampered.public_key = other.public_key;
        assert!(matches!(
            verify_at_origin(&tampered, &grant(), &origin),
            Err(SessionRecoveryError::InvalidIdentity)
        ));
        assert!(
            verify_at_origin(&key, &grant(), &Url::parse("http://example.com/").unwrap()).is_err()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejected_worker_identity_never_starts_a_session_child() {
        use std::collections::BTreeMap;
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        let identity = identity();
        let granted = grant();
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("child.sh");
        let marker = root.path().join("executed");
        fs::write(
            &executable,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let source: BTreeMap<String, String> = [
            ("GITHUB_ACTIONS", "true"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
            ("GITHUB_WORKFLOW", "ubuntu"),
            ("GITHUB_RUN_ID", "44931213131"),
            ("GITHUB_RUN_ATTEMPT", "1"),
            ("ATTEMPT_ID", "123e4567-e89b-42d3-a456-426614174004"),
            ("RUNNER_TEMP", "/tmp"),
            ("RUNNER_TRACKING_ID", "synthetic-job"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin = Url::parse(&format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        ))
        .unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let (route, _) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/session/challenge HTTP/1.1");
            reply(
                &mut socket,
                "200 OK",
                json!({"device_id":"123e4567-e89b-42d3-a456-426614174002","nonce":NONCE}),
            );
        });
        assert!(matches!(
            recover_and_spawn_at_origin(&identity, &granted, &origin, &executable, &source),
            Err(SessionLaunchError::Recovery(SessionRecoveryError::Rejected))
        ));
        server.join().unwrap();
        assert!(
            !marker.exists(),
            "unverified Worker identity launched a child"
        );
    }

    #[test]
    fn server_mismatch_and_redirect_never_advance_to_recovery() {
        for status in ["200 OK", "302 Found"] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let origin = Url::parse(&format!(
                "http://127.0.0.1:{}/",
                listener.local_addr().unwrap().port()
            ))
            .unwrap();
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let (route, _) = recv_request(&mut socket);
                assert_eq!(route, "POST /agent/session/challenge HTTP/1.1");
                reply(
                    &mut socket,
                    status,
                    json!({"device_id":"123e4567-e89b-42d3-a456-426614174002","nonce":NONCE}),
                );
            });
            assert!(matches!(
                verify_at_origin(&identity(), &grant(), &origin),
                Err(SessionRecoveryError::Rejected)
            ));
            server.join().unwrap();
        }
    }

    #[test]
    fn unverified_recovery_reply_is_not_a_device_identity() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin = Url::parse(&format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        ))
        .unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            recv_request(&mut socket);
            reply(
                &mut socket,
                "200 OK",
                json!({"device_id":DEVICE,"nonce":NONCE}),
            );
            let (mut socket, _) = listener.accept().unwrap();
            let (route, _) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/session/recover HTTP/1.1");
            reply(
                &mut socket,
                "200 OK",
                json!({"status":"verified","device_id":"123e4567-e89b-42d3-a456-426614174002"}),
            );
        });
        assert!(matches!(
            verify_at_origin(&identity(), &grant(), &origin),
            Err(SessionRecoveryError::Rejected)
        ));
        server.join().unwrap();
    }

    #[test]
    fn oversize_and_invalid_nonce_are_rejected() {
        for nonce in ["short", "AAAAAAAAAAAAAAAAAAAAAAAA"] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let origin = Url::parse(&format!(
                "http://127.0.0.1:{}/",
                listener.local_addr().unwrap().port()
            ))
            .unwrap();
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                recv_request(&mut socket);
                let body = if nonce == "short" {
                    json!({"device_id":DEVICE,"nonce":nonce})
                } else {
                    json!({"device_id":DEVICE,"nonce":nonce,"extra":"x".repeat(1100)})
                };
                reply(&mut socket, "200 OK", body);
            });
            assert!(matches!(
                verify_at_origin(&identity(), &grant(), &origin),
                Err(SessionRecoveryError::Rejected)
            ));
            server.join().unwrap();
        }
    }
}
