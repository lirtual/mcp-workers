//! One-shot GitHub-hosted Session OIDC and RCA enrollment HTTP contract.
//! No production registration is attempted by this library test suite.

use crate::identity::valid_device_id;
use crate::session_enrollment::{
    sign_session_enrollment_nonce, validate_session_identity, SessionDeviceIdentity,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::blocking::{Client, Request};
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use url::Url;

const RCA_ENROLLMENT_URL: &str = "https://rca.lirtual.dpdns.org/agent/pair/start";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SESSION_GRANT_MS: u64 = 300 * 60_000;
const OIDC_RESPONSE_LIMIT: usize = 8192;
const ENROLLMENT_RESPONSE_LIMIT: usize = 1024;

/// Shared expiry/UUID admission for the long-lived credential-free transport.
/// Registration responses alone are not proof that a usable grant is safe to launch.
pub fn valid_session_transport_grant(grant: &RegisteredSessionDevice, now_ms: u64) -> bool {
    valid_device_id(&grant.device_id)
        && grant.expires_at > now_ms
        && grant.expires_at <= MAX_SAFE_INTEGER
        && grant.expires_at <= now_ms.saturating_add(MAX_SESSION_GRANT_MS)
}

#[derive(Debug, Error)]
pub enum SessionRegistrationError {
    #[error("invalid GitHub Runner OIDC context")]
    InvalidOidcContext,
    #[error("GitHub Runner OIDC unavailable")]
    OidcUnavailable,
    #[error("invalid GitHub Runner OIDC response")]
    InvalidOidcResponse,
    #[error("invalid Session enrollment context")]
    InvalidEnrollment,
    #[error("Session enrollment unavailable")]
    EnrollmentUnavailable,
    #[error("invalid Session enrollment response")]
    InvalidEnrollmentResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredSessionDevice {
    pub device_id: String,
    /// Milliseconds since Unix epoch; expires with the GitHub physical Attempt.
    pub expires_at: u64,
}

fn session_http_client() -> Result<Client, SessionRegistrationError> {
    // Never redirect a bearer token or an enrollment JWT to another origin,
    // and never pass either through ambient HTTP_PROXY / HTTPS_PROXY.
    Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| SessionRegistrationError::InvalidOidcContext)
}

fn build_oidc_request(
    client: &Client,
    url: &str,
    bearer: &str,
    audience: &str,
) -> Result<Request, SessionRegistrationError> {
    let mut target = Url::parse(url).map_err(|_| SessionRegistrationError::InvalidOidcContext)?;
    if target.scheme() != "https"
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
        || bearer.len() < 32
        || !(8..=256).contains(&audience.len())
    {
        return Err(SessionRegistrationError::InvalidOidcContext);
    }
    // URLSearchParams.set() in the shipped Node reference replaces any
    // preexisting audience without discarding unrelated GitHub query fields.
    let retained: Vec<(String, String)> = target
        .query_pairs()
        .filter(|(key, _)| key != "audience")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    target.set_query(None);
    {
        let mut query = target.query_pairs_mut();
        for (key, value) in &retained {
            query.append_pair(key, value);
        }
        query.append_pair("audience", audience);
    }
    client
        .get(target)
        .header("authorization", format!("Bearer {bearer}"))
        .header("accept", "application/json")
        .build()
        .map_err(|_| SessionRegistrationError::InvalidOidcContext)
}

fn read_bounded_body(reader: &mut impl Read, limit: usize) -> Result<Vec<u8>, ()> {
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > limit {
        return Err(());
    }
    Ok(bytes)
}

fn parse_oidc_response(
    status: u16,
    declared_length: Option<u64>,
    body: &[u8],
) -> Result<String, SessionRegistrationError> {
    if status != 200
        || declared_length.is_some_and(|len| len > OIDC_RESPONSE_LIMIT as u64)
        || body.len() > OIDC_RESPONSE_LIMIT
    {
        return Err(SessionRegistrationError::InvalidOidcResponse);
    }
    let value: Value =
        serde_json::from_slice(body).map_err(|_| SessionRegistrationError::InvalidOidcResponse)?;
    let jwt = value
        .get("value")
        .and_then(Value::as_str)
        .ok_or(SessionRegistrationError::InvalidOidcResponse)?;
    let segments: Vec<&str> = jwt.split('.').collect();
    if jwt.len() > OIDC_RESPONSE_LIMIT
        || segments.len() != 3
        || segments.iter().any(|s| {
            s.is_empty()
                || !s
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
    {
        return Err(SessionRegistrationError::InvalidOidcResponse);
    }
    Ok(jwt.to_owned())
}

/// One-use GitHub-hosted Runner OIDC proof, to be consumed only by the
/// short-lived registration process. Never copy it into Session child env.
pub fn runner_oidc_token(
    url: &str,
    bearer: &str,
    audience: &str,
) -> Result<String, SessionRegistrationError> {
    let client = session_http_client()?;
    let request = build_oidc_request(&client, url, bearer, audience)?;
    let mut response = client
        .execute(request)
        .map_err(|_| SessionRegistrationError::OidcUnavailable)?;
    if response.status().as_u16() != 200
        || response
            .content_length()
            .is_some_and(|len| len > OIDC_RESPONSE_LIMIT as u64)
    {
        return Err(SessionRegistrationError::OidcUnavailable);
    }
    let body = read_bounded_body(&mut response, OIDC_RESPONSE_LIMIT)
        .map_err(|_| SessionRegistrationError::InvalidOidcResponse)?;
    parse_oidc_response(200, response.content_length(), &body)
}

fn build_enrollment_request(
    client: &Client,
    identity: &SessionDeviceIdentity,
    oidc_jwt: &str,
    nonce: &str,
) -> Result<Request, SessionRegistrationError> {
    validate_session_identity(identity, &identity.attempt)
        .map_err(|_| SessionRegistrationError::InvalidEnrollment)?;
    if !(32..=8192).contains(&oidc_jwt.len())
        || !oidc_jwt
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err(SessionRegistrationError::InvalidEnrollment);
    }
    let proof = sign_session_enrollment_nonce(identity, nonce)
        .map_err(|_| SessionRegistrationError::InvalidEnrollment)?;
    client
        .post(RCA_ENROLLMENT_URL)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .json(&json!({
            "kind": "github_session",
            "attempt_id": identity.attempt.attempt_id,
            "oidc_jwt": oidc_jwt,
            "public_key": identity.public_key,
            "nonce": nonce,
            "proof": proof,
        }))
        .build()
        .map_err(|_| SessionRegistrationError::InvalidEnrollment)
}

fn parse_enrollment_response(
    status: u16,
    declared_length: Option<u64>,
    body: &[u8],
    now_ms: u64,
) -> Result<RegisteredSessionDevice, SessionRegistrationError> {
    if !matches!(status, 200 | 201)
        || declared_length.is_some_and(|len| len > ENROLLMENT_RESPONSE_LIMIT as u64)
        || body.len() > ENROLLMENT_RESPONSE_LIMIT
    {
        return Err(SessionRegistrationError::InvalidEnrollmentResponse);
    }
    let result: Value = serde_json::from_slice(body)
        .map_err(|_| SessionRegistrationError::InvalidEnrollmentResponse)?;
    let object = result
        .as_object()
        .ok_or(SessionRegistrationError::InvalidEnrollmentResponse)?;
    let device_id = object
        .get("device_id")
        .and_then(Value::as_str)
        .ok_or(SessionRegistrationError::InvalidEnrollmentResponse)?;
    let expires_at = object
        .get("expires_at")
        .and_then(Value::as_u64)
        .ok_or(SessionRegistrationError::InvalidEnrollmentResponse)?;
    let status = object.get("status").and_then(Value::as_str);
    if !valid_device_id(device_id)
        || expires_at > MAX_SAFE_INTEGER
        || expires_at <= now_ms
        || !matches!(status, Some("registered" | "already_registered"))
    {
        return Err(SessionRegistrationError::InvalidEnrollmentResponse);
    }
    Ok(RegisteredSessionDevice {
        device_id: device_id.to_owned(),
        expires_at,
    })
}

/// Exchange a disposable Attempt's signed nonce + GitHub JWT against the
/// existing fixed RCA enrollment origin. This does not start an Agent.
pub fn register_session_device(
    identity: &SessionDeviceIdentity,
    oidc_jwt: &str,
) -> Result<RegisteredSessionDevice, SessionRegistrationError> {
    let client = session_http_client()?;
    let mut random_nonce = [0u8; 18];
    getrandom::fill(&mut random_nonce).map_err(|_| SessionRegistrationError::InvalidEnrollment)?;
    let nonce = URL_SAFE_NO_PAD.encode(random_nonce);
    random_nonce.fill(0);
    let request = build_enrollment_request(&client, identity, oidc_jwt, &nonce)?;
    let mut response = client
        .execute(request)
        .map_err(|_| SessionRegistrationError::EnrollmentUnavailable)?;
    let status = response.status().as_u16();
    if !matches!(status, 200 | 201)
        || response
            .content_length()
            .is_some_and(|len| len > ENROLLMENT_RESPONSE_LIMIT as u64)
    {
        return Err(SessionRegistrationError::EnrollmentUnavailable);
    }
    let body = read_bounded_body(&mut response, ENROLLMENT_RESPONSE_LIMIT)
        .map_err(|_| SessionRegistrationError::InvalidEnrollmentResponse)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SessionRegistrationError::InvalidEnrollmentResponse)?
        .as_millis();
    let now_ms =
        u64::try_from(now).map_err(|_| SessionRegistrationError::InvalidEnrollmentResponse)?;
    parse_enrollment_response(status, response.content_length(), &body, now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_enrollment::{new_session_identity, SessionPhysicalAttempt};
    use serde_json::Value;

    fn identity() -> SessionDeviceIdentity {
        new_session_identity(&SessionPhysicalAttempt {
            attempt_id: "123e4567-e89b-42d3-a456-426614174004".into(),
            github_run_id: 123,
            github_run_attempt: 2,
            workflow_name: "ubuntu".into(),
        })
        .unwrap()
    }

    #[test]
    fn oidc_request_uses_exact_audience_and_no_untrusted_scheme() {
        let client = session_http_client().unwrap();
        let bearer = "synthetic-runner-token-0123456789abcdef";
        let request = build_oidc_request(
            &client,
            "https://oidc.example/token?trace=abc&audience=old",
            bearer,
            "https://rca.lirtual.dpdns.org",
        )
        .unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.url().scheme(), "https");
        assert_eq!(
            request
                .url()
                .query_pairs()
                .filter(|(k, _)| k == "audience")
                .count(),
            1
        );
        assert_eq!(
            request
                .url()
                .query_pairs()
                .find(|(k, _)| k == "audience")
                .unwrap()
                .1,
            "https://rca.lirtual.dpdns.org"
        );
        assert!(request
            .url()
            .query_pairs()
            .any(|(k, v)| k == "trace" && v == "abc"));
        assert_eq!(
            request.headers()["authorization"],
            format!("Bearer {bearer}")
        );
        assert_eq!(request.headers()["accept"], "application/json");
        for url in [
            "http://oidc.example/token",
            "ftp://oidc.example/token",
            "https://user:pass@oidc.example/token",
            "https://oidc.example/token#frag",
        ] {
            assert!(
                build_oidc_request(&client, url, bearer, "eightchars").is_err(),
                "{url}"
            );
        }
        assert!(build_oidc_request(
            &client,
            "https://oidc.example/token",
            "too-short",
            "eightchars"
        )
        .is_err());
        assert!(
            build_oidc_request(&client, "https://oidc.example/token", bearer, "short").is_err()
        );
    }

    #[test]
    fn oidc_response_requires_single_bounded_jwt_and_success() {
        let jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
        let body = serde_json::to_vec(&serde_json::json!({"value":jwt})).unwrap();
        assert_eq!(
            parse_oidc_response(200, Some(body.len() as u64), &body).unwrap(),
            jwt
        );
        for (status, body) in [
            (302, body.clone()),
            (200, br#"{"value":"not-a-jwt"}"#.to_vec()),
            (200, br#"{"value":"header.body."}"#.to_vec()),
            (200, br#"{"value":12}"#.to_vec()),
            (200, br#"[]"#.to_vec()),
            (200, vec![b'x'; 8193]),
        ] {
            assert!(parse_oidc_response(status, None, &body).is_err());
        }
        assert!(parse_oidc_response(200, Some(8193), &body).is_err());
    }

    #[test]
    fn session_enrollment_posts_only_signed_attempt_to_fixed_origin() {
        let client = session_http_client().unwrap();
        let identity = identity();
        let jwt = "header.body.signature0123456789abcdefghijklmnop";
        let nonce = "abcdefghijklmnopqrstuvwx";
        let request = build_enrollment_request(&client, &identity, jwt, nonce).unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.url().as_str(),
            "https://rca.lirtual.dpdns.org/agent/pair/start"
        );
        assert_eq!(request.headers()["content-type"], "application/json");
        assert_eq!(request.headers()["cache-control"], "no-store");
        let body: Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["kind"], "github_session");
        assert_eq!(body["attempt_id"], identity.attempt.attempt_id);
        assert_eq!(body["public_key"], identity.public_key);
        assert_eq!(body["nonce"], nonce);
        assert_eq!(body["oidc_jwt"], jwt);
        assert_eq!(
            body["proof"],
            sign_session_enrollment_nonce(&identity, nonce).unwrap()
        );
        assert_eq!(body.as_object().unwrap().len(), 6);
        assert!(build_enrollment_request(&client, &identity, "", nonce).is_err());
        assert!(build_enrollment_request(&client, &identity, &"x".repeat(8193), nonce).is_err());
        assert!(build_enrollment_request(&client, &identity, jwt, "short").is_err());
    }

    #[test]
    fn enrollment_response_rejects_expired_forged_or_unbounded_grants() {
        let now = 1_700_000_000_000_u64;
        let id = "123e4567-e89b-42d3-a456-426614174001";
        for status in ["registered", "already_registered"] {
            let body = serde_json::to_vec(&serde_json::json!({
                "status": status, "device_id":id, "expires_at":now + 60_000
            }))
            .unwrap();
            let result =
                parse_enrollment_response(201, Some(body.len() as u64), &body, now).unwrap();
            assert_eq!(result.device_id, id);
            assert_eq!(result.expires_at, now + 60_000);
            assert!(parse_enrollment_response(302, None, &body, now).is_err());
            assert!(parse_enrollment_response(201, Some(1025), &body, now).is_err());
        }
        for forged in [
            serde_json::json!({"status":"registered","device_id":"bad","expires_at":now+60000}),
            serde_json::json!({"status":"registered","device_id":id,"expires_at":now}),
            serde_json::json!({"status":"denied","device_id":id,"expires_at":now+60000}),
            serde_json::json!({"status":"registered","device_id":id,"expires_at":9_007_199_254_740_992_u64}),
            serde_json::json!({"status":"registered","device_id":id,"expires_at":"later"}),
        ] {
            assert!(parse_enrollment_response(
                200,
                None,
                &serde_json::to_vec(&forged).unwrap(),
                now
            )
            .is_err());
        }
        assert!(parse_enrollment_response(200, None, &vec![b'x'; 1025], now).is_err());
    }

    #[test]
    fn bounded_body_reader_never_accepts_large_streams() {
        let mut oversized = std::io::Cursor::new(vec![b'a'; 9000]);
        assert!(read_bounded_body(&mut oversized, 8192).is_err());
        let mut exact = std::io::Cursor::new(vec![b'a'; 1024]);
        assert_eq!(read_bounded_body(&mut exact, 1024).unwrap().len(), 1024);
    }

    #[test]
    fn real_http_client_refuses_to_follow_a_redirect() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 512];
            let _ = stream.read(&mut request).unwrap();
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/not-followed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let response = session_http_client().unwrap().get(origin).send().unwrap();
        assert_eq!(response.status().as_u16(), 302);
        server.join().unwrap();
    }
}
