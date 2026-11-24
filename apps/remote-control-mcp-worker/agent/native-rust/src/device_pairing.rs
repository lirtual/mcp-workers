//! Owner-reviewed single-code enrollment. A pending code is not approval;
//! signed recovery of the same local key must confirm the device identity.
use crate::identity::{new_private_key_pem, public_key, signing_key, valid_device_id};
use crate::session_recovery::{
    post_bounded, recover_approved_key, recovery_client, SessionRecoveryError,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::Signer;
use reqwest::blocking::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

const DOMAIN: &str = "remote-control:v2:pending:";
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub struct PendingEnrollment {
    pub code: String,
    pub fingerprint: String,
    pub request: Value,
}

pub fn generate_private_pem() -> Result<String, SessionRecoveryError> {
    new_private_key_pem().map_err(|_| SessionRecoveryError::Unavailable)
}

pub fn new_pending_enrollment(
    name: &str,
    pem: &str,
    temporary: bool,
) -> Result<PendingEnrollment, SessionRecoveryError> {
    if name.is_empty() || name.encode_utf16().count() > 64 || name.chars().any(|c| c < '\u{20}') {
        return Err(SessionRecoveryError::InvalidIdentity);
    }
    let key = signing_key(pem).map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    let public = public_key(&key).map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    let mut entropy = [0u8; 10];
    getrandom::fill(&mut entropy).map_err(|_| SessionRecoveryError::Unavailable)?;
    let code: String = entropy
        .iter()
        .map(|b| ALPHABET[usize::from(b & 31)] as char)
        .collect();
    let verifier = format!("{:x}", Sha256::digest(format!("{DOMAIN}{code}")));
    let issued_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SessionRecoveryError::Unavailable)?
        .as_millis() as u64;
    let mode = if temporary { ":temporary" } else { "" };
    let transcript = format!("{DOMAIN}{verifier}:{public}:{name}:{issued_at}{mode}:single-code-v1");
    let proof = STANDARD.encode(key.sign(transcript.as_bytes()).to_bytes());
    let mut request = json!({"name":name,"public_key":public,"code_verifier":verifier,
        "proof":proof,"issued_at":issued_at,"pairing_protocol":"single-code-v1"});
    if temporary {
        request["grant_type"] = json!("temporary");
    }
    let der = STANDARD
        .decode(public)
        .map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    let fingerprint = format!("{:x}", Sha256::digest(der))[..24].to_owned();
    Ok(PendingEnrollment {
        code,
        fingerprint,
        request,
    })
}

pub struct PairingClient {
    origin: Url,
    client: Client,
}
impl PairingClient {
    pub fn new(endpoint: &str) -> Result<Self, SessionRecoveryError> {
        let origin = Url::parse(endpoint).map_err(|_| SessionRecoveryError::InvalidIdentity)?;
        if origin.scheme() != "https"
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err(SessionRecoveryError::InvalidIdentity);
        }
        Ok(Self {
            origin,
            client: recovery_client()?,
        })
    }
    fn start(&self, enrollment: &PendingEnrollment) -> Result<(), SessionRecoveryError> {
        let result = post_bounded(
            &self.client,
            &self.origin,
            "/agent/pair/start",
            enrollment.request.clone(),
            202,
            false,
        )?;
        if result.get("status").and_then(Value::as_str) != Some("pending") {
            return Err(SessionRecoveryError::Rejected);
        }
        Ok(())
    }
    pub fn recover(
        &self,
        pem: &str,
        expected: Option<&str>,
    ) -> Result<String, SessionRecoveryError> {
        recover_approved_key(&self.client, &self.origin, pem, expected)
    }
    /// Signed negative approval status, not proof of a historical ID/key
    /// binding. Only exact HTTP 200 / not_approved / matching ID permits
    /// the owner-local replacement transaction to proceed.
    pub fn assert_revoked(&self, pem: &str, device_id: &str) -> Result<(), SessionRecoveryError> {
        if !valid_device_id(device_id) {
            return Err(SessionRecoveryError::InvalidIdentity);
        }
        let key = signing_key(pem).map_err(|_| SessionRecoveryError::InvalidIdentity)?;
        let public = public_key(&key).map_err(|_| SessionRecoveryError::InvalidIdentity)?;
        let issued_at: u64 = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| SessionRecoveryError::Unavailable)?
            .as_millis()
            .try_into()
            .map_err(|_| SessionRecoveryError::Unavailable)?;
        let transcript =
            format!("remote-control:v2:re-pair-revoked:{device_id}:{public}:{issued_at}");
        let proof = STANDARD.encode(key.sign(transcript.as_bytes()).to_bytes());
        let result = post_bounded(
            &self.client,
            &self.origin,
            "/agent/re-pair/status",
            json!({"device_id":device_id,"public_key":public,"issued_at":issued_at,"proof":proof}),
            200,
            false,
        )?;
        if result.get("status").and_then(Value::as_str) != Some("not_approved")
            || result.get("device_id").and_then(Value::as_str) != Some(device_id)
        {
            return Err(SessionRecoveryError::Rejected);
        }
        Ok(())
    }

    /// At most one pending registration per explicit pairing. Never rotate
    /// or re-register a confirmed ID or treat a network error as pending.
    pub fn pair(
        &self,
        pem: &str,
        expected: Option<&str>,
        name: &str,
        temporary: bool,
        display: impl FnOnce(&PendingEnrollment),
    ) -> Result<String, SessionRecoveryError> {
        match self.recover(pem, expected) {
            Ok(id) => return Ok(id),
            Err(SessionRecoveryError::Pending) if expected.is_none() => {}
            Err(error) => return Err(error),
        }
        let enrollment = new_pending_enrollment(name, pem, temporary)?;
        self.start(&enrollment)?;
        display(&enrollment);
        let deadline = Instant::now() + Duration::from_secs(600);
        while Instant::now() < deadline {
            match self.recover(pem, None) {
                Ok(id) => return Ok(id),
                Err(SessionRecoveryError::Pending) => std::thread::sleep(
                    Duration::from_secs(5).min(deadline.saturating_duration_since(Instant::now())),
                ),
                Err(error) => return Err(error),
            }
        }
        Err(SessionRecoveryError::Pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_recovery::tests::{recv_request, reply};
    use std::net::TcpListener;

    const ID: &str = "123e4567-e89b-42d3-a456-426614174001";
    const NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAAAA";

    fn fixture() -> (PairingClient, TcpListener) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin = Url::parse(&format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        ))
        .unwrap();
        (
            PairingClient {
                origin,
                client: recovery_client().unwrap(),
            },
            listener,
        )
    }

    #[test]
    fn revoked_status_requires_exact_signed_negative_response() {
        use ed25519_dalek::{Signature, Verifier};
        for (status, payload, accepted) in [
            (200, json!({"status":"not_approved","device_id":ID}), true),
            (200, json!({"status":"approved","device_id":ID}), false),
            (
                200,
                json!({"status":"not_approved","device_id":"123e4567-e89b-42d3-a456-426614174002"}),
                false,
            ),
            (401, json!({"status":"not_approved","device_id":ID}), false),
            (403, json!({"status":"not_approved","device_id":ID}), false),
            (404, json!({"status":"not_approved","device_id":ID}), false),
            (409, json!({"status":"not_approved","device_id":ID}), false),
            (429, json!({"status":"not_approved","device_id":ID}), false),
            (503, json!({"status":"not_approved","device_id":ID}), false),
        ] {
            let (client, listener) = fixture();
            let pem = generate_private_pem().unwrap();
            let key = signing_key(&pem).unwrap();
            let public = public_key(&key).unwrap();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let (path, body) = recv_request(&mut socket);
                assert_eq!(path, "POST /agent/re-pair/status HTTP/1.1");
                assert_eq!(body["device_id"], ID);
                assert_eq!(body["public_key"], public);
                let issued = body["issued_at"].as_u64().unwrap();
                let signature = Signature::from_slice(
                    &STANDARD.decode(body["proof"].as_str().unwrap()).unwrap(),
                )
                .unwrap();
                // Independent Node/Worker transcript contract.
                let message = format!("remote-control:v2:re-pair-revoked:{ID}:{public}:{issued}");
                key.verifying_key()
                    .verify(message.as_bytes(), &signature)
                    .unwrap();
                reply(&mut socket, &format!("{status} Fixture"), payload);
            });
            assert_eq!(client.assert_revoked(&pem, ID).is_ok(), accepted);
            server.join().unwrap();
        }
    }

    #[test]
    fn actual_pending_http_then_signed_recovery_of_same_key() {
        let (client, listener) = fixture();
        let pem = generate_private_pem().unwrap();
        let public = public_key(&signing_key(&pem).unwrap()).unwrap();
        let expected_pem = pem.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let (route, request) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/session/challenge HTTP/1.1");
            assert_eq!(request["public_key"], public);
            reply(&mut socket, "404 Not Found", json!({}));
            let (mut socket, _) = listener.accept().unwrap();
            let (route, request) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/pair/start HTTP/1.1");
            assert_eq!(request["public_key"], public);
            assert_eq!(request["pairing_protocol"], "single-code-v1");
            assert_eq!(request["name"], "fixture");
            assert!(request.get("grant_type").is_none());
            assert!(request.get("code").is_none());
            reply(&mut socket, "202 Accepted", json!({"status":"pending"}));
            let (mut socket, _) = listener.accept().unwrap();
            let (route, request) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/session/challenge HTTP/1.1");
            assert_eq!(request["public_key"], public);
            reply(&mut socket, "200 OK", json!({"device_id":ID,"nonce":NONCE}));
            let (mut socket, _) = listener.accept().unwrap();
            let (route, request) = recv_request(&mut socket);
            assert_eq!(route, "POST /agent/session/recover HTTP/1.1");
            assert_eq!(request["device_id"], ID);
            assert_eq!(request["nonce"], NONCE);
            assert_eq!(
                request["proof"],
                crate::identity::signed_session_proof(&expected_pem, ID, NONCE)
                    .unwrap()
                    .proof
            );
            reply(
                &mut socket,
                "200 OK",
                json!({"status":"verified","device_id":ID}),
            );
        });
        let mut displayed = false;
        let actual = client
            .pair(&pem, None, "fixture", false, |pending| {
                displayed = true;
                assert_eq!(pending.code.len(), 10);
            })
            .unwrap();
        assert!(displayed);
        assert_eq!(actual, ID);
        server.join().unwrap();
    }

    #[test]
    fn known_identity_or_non_pending_rejection_never_registers() {
        for (status, expected) in [
            ("404 Not Found", Some(ID)),
            ("403 Forbidden", None),
            ("429 Too Many Requests", None),
        ] {
            let (client, listener) = fixture();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let (route, _) = recv_request(&mut socket);
                assert_eq!(route, "POST /agent/session/challenge HTTP/1.1");
                reply(&mut socket, status, json!({}));
            });
            let result = client.pair(
                &generate_private_pem().unwrap(),
                expected,
                "fixture",
                false,
                |_| panic!("unapproved rejection attempted registration"),
            );
            match status {
                "404 Not Found" | "403 Forbidden" => {
                    assert!(matches!(result, Err(SessionRecoveryError::Denied)))
                }
                _ => assert!(matches!(result, Err(SessionRecoveryError::Rejected))),
            }
            server.join().unwrap();
        }
    }
}
