//! Owner-reviewed single-code enrollment. A pending code is not approval;
//! signed recovery of the same local key must confirm the device identity.
use crate::identity::{new_private_key_pem, public_key, signing_key};
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

// Standard Windows keeps the original same-key identity and install-mode
// contract. Pairing is deliberately separate from Task publication.
#[cfg(windows)]
pub fn pair_windows_identity(
    directory: &std::path::Path,
    client: &PairingClient,
    name: &str,
    temporary: bool,
    display: impl FnOnce(&PendingEnrollment),
) -> Result<String, SessionRecoveryError> {
    pair_windows_identity_with(directory, temporary, |pem, expected| {
        client.pair(pem, expected, name, temporary, display)
    })
}

#[cfg(windows)]
fn pair_windows_identity_with(
    directory: &std::path::Path,
    temporary: bool,
    resolve: impl FnOnce(&str, Option<&str>) -> Result<String, SessionRecoveryError>,
) -> Result<String, SessionRecoveryError> {
    use crate::{seal_new_windows_private_file, validate_windows_private_path};
    use std::fs::{self, OpenOptions};
    use std::io::{ErrorKind, Read, Write};
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
    let invalid = || SessionRecoveryError::InvalidIdentity;
    fn present(path: &Path) -> Result<bool, SessionRecoveryError> {
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
            Err(_) => Err(SessionRecoveryError::Unavailable),
        }
    }
    fn read(path: &Path, max: u64) -> Result<Option<String>, SessionRecoveryError> {
        if !present(path)? {
            return Ok(None);
        }
        validate_windows_private_path(path, false)
            .map_err(|_| SessionRecoveryError::InvalidIdentity)?;
        let mut file = fs::File::open(path).map_err(|_| SessionRecoveryError::Unavailable)?;
        let mut value = String::new();
        (&mut file)
            .take(max + 1)
            .read_to_string(&mut value)
            .map_err(|_| SessionRecoveryError::InvalidIdentity)?;
        if value.is_empty() || value.len() as u64 > max {
            return Err(SessionRecoveryError::InvalidIdentity);
        }
        Ok(Some(value))
    }
    fn write_new(path: &Path, bytes: &[u8]) -> Result<(), SessionRecoveryError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| SessionRecoveryError::Unavailable)?;
        seal_new_windows_private_file(path).map_err(|_| SessionRecoveryError::InvalidIdentity)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| SessionRecoveryError::Unavailable)
    }
    validate_windows_private_path(directory, true).map_err(|_| invalid())?;
    let key = directory.join("v2-identity.pem");
    let id = directory.join("v2-identity.pem.device-id");
    let mode = directory.join("v2-identity.pem.install-mode");
    let activation = directory.join("v2-identity.pem.activation-pending");
    let required_mode = if temporary {
        "temporary\n"
    } else {
        "permanent\n"
    };
    for name in [
        "v2-identity.pem.owner-stopped",
        "windows-native-upgrade.json",
        "v2-identity.pem.device-id.pending",
    ] {
        if present(&directory.join(name))? {
            return Err(invalid());
        }
    }
    if !present(&mode)? {
        if present(&key)? || present(&id)? || present(&activation)? {
            return Err(invalid()); // Legacy state requires its reviewed upgrade path.
        }
        write_new(&mode, required_mode.as_bytes())?;
    }
    validate_windows_private_path(&mode, false).map_err(|_| invalid())?;
    // Hold the existing immutable mode file against another pairing writer
    // or deletion. No additional durable lock or new state format.
    let mut guard = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ)
        .open(&mode)
        .map_err(|_| SessionRecoveryError::Unavailable)?;
    let mut saved_mode = String::new();
    (&mut guard)
        .take(32)
        .read_to_string(&mut saved_mode)
        .map_err(|_| invalid())?;
    if saved_mode != required_mode {
        return Err(invalid());
    }
    let existing = read(&id, 128)?;
    let pending = read(&activation, 128)?;
    if temporary && pending.is_some() {
        return Err(invalid());
    }
    let expected = existing.as_deref().or(pending.as_deref()).map(str::trim);
    if expected.is_some_and(|value| !crate::identity::valid_device_id(value))
        || matches!((&existing, &pending), (Some(a), Some(b)) if a != b)
    {
        return Err(invalid());
    }
    let pem = match read(&key, 8192)? {
        Some(value) => value,
        None if expected.is_none() => {
            let value = generate_private_pem()?;
            write_new(&key, value.as_bytes())?;
            value
        }
        None => return Err(invalid()),
    };
    signing_key(&pem).map_err(|_| invalid())?;
    let approved = resolve(&pem, expected)?;
    if !crate::identity::valid_device_id(&approved)
        || expected.is_some_and(|value| value != approved)
    {
        return Err(invalid());
    }
    if existing.is_none() {
        let value = format!("{approved}\n");
        // Write the existing activation intent before the new ID. A lost
        // local write is recovered against the same signed key/expected ID.
        if !temporary && pending.is_none() {
            write_new(&activation, value.as_bytes())?;
        }
        write_new(&id, value.as_bytes())?;
    }
    drop(guard);
    Ok(approved)
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

    #[cfg(windows)]
    #[test]
    fn windows_native_pairing_reuses_key_mode_and_activation_intent() {
        let directory = tempfile::tempdir().unwrap();
        crate::seal_new_windows_private_directory(directory.path()).unwrap();
        let root = directory.path();
        let key = root.join("v2-identity.pem");
        let id = root.join("v2-identity.pem.device-id");
        let activation = root.join("v2-identity.pem.activation-pending");
        assert!(pair_windows_identity_with(root, false, |_, previous| {
            assert!(previous.is_none());
            Err(SessionRecoveryError::Pending)
        })
        .is_err());
        let old = std::fs::read_to_string(&key).unwrap();
        assert!(!id.exists() && !activation.exists());
        assert!(pair_windows_identity_with(root, true, |_, _| panic!("mode changed")).is_err());
        let recovered = pair_windows_identity_with(root, false, |pem, previous| {
            assert_eq!(pem, old);
            assert!(previous.is_none());
            assert!(
                pair_windows_identity_with(root, false, |_, _| panic!("pair lock bypassed"))
                    .is_err()
            );
            Ok(ID.to_owned())
        })
        .unwrap();
        assert_eq!(recovered, ID);
        assert_eq!(std::fs::read_to_string(&activation).unwrap().trim(), ID);
        std::fs::remove_file(&id).unwrap(); // Interruption before ID publication.
        pair_windows_identity_with(root, false, |pem, expected| {
            assert_eq!(pem, old);
            assert_eq!(expected, Some(ID));
            Ok(ID.to_owned())
        })
        .unwrap();
        std::fs::remove_file(&activation).unwrap(); // Committed activation.
        assert!(pair_windows_identity_with(root, false, |_, _| Ok(
            "123e4567-e89b-42d3-a456-426614174002".to_owned()
        ))
        .is_err());
        pair_windows_identity_with(root, false, |pem, expected| {
            assert_eq!(pem, old);
            assert_eq!(expected, Some(ID));
            Ok(ID.to_owned())
        })
        .unwrap();
        assert!(
            !activation.exists(),
            "healthy repeat must not schedule activation"
        );
        assert_eq!(std::fs::read_to_string(id).unwrap().trim(), ID);
    }

    #[cfg(windows)]
    #[test]
    fn windows_temporary_pairing_never_creates_permanent_intent() {
        let directory = tempfile::tempdir().unwrap();
        crate::seal_new_windows_private_directory(directory.path()).unwrap();
        let root = directory.path();
        let id = pair_windows_identity_with(root, true, |_, previous| {
            assert!(previous.is_none());
            Ok(ID.to_owned())
        })
        .unwrap();
        assert_eq!(id, ID);
        assert!(!root.join("v2-identity.pem.activation-pending").exists());
        assert!(pair_windows_identity_with(root, false, |_, _| panic!(
            "temporary became permanent"
        ))
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("v2-identity.pem.install-mode")).unwrap(),
            "temporary\n"
        );
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
            assert!(matches!(result, Err(SessionRecoveryError::Rejected)));
            server.join().unwrap();
        }
    }
}
