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
    /// Print only the canonical browser link for enrollment on that origin.
    /// Noncanonical endpoints cannot use the production browser approval;
    /// never send their pending code to a different origin.
    pub fn approval_instruction(&self, pending: &PendingEnrollment, mode: &str) -> String {
        let endpoint = self.origin.as_str();
        if endpoint == "https://rca.lirtual.dpdns.org/" {
            format!("Authorize device (10 min): https://rca.lirtual.dpdns.org/pair#{}\nLocal public key fingerprint: {}\nConfirm the fingerprint and {mode} mode in your browser.", pending.code, pending.fingerprint)
        } else {
            format!("Local public key fingerprint: {}\nBrowser approval is unavailable on this endpoint for {mode} mode. Use the official RCA installer for the canonical endpoint.", pending.fingerprint)
        }
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

    /// Read-only evidence that the recovered key's ID has a permanent
    /// grant. The challenge alone does not change owner intent.
    pub fn verify_permanent_grant(&self, id: &str) -> Result<(), SessionRecoveryError> {
        self.owner_challenge(id, "stop").map(|_| ())
    }

    fn owner_challenge(
        &self,
        id: &str,
        action: &str,
    ) -> Result<(String, u64), SessionRecoveryError> {
        if !valid_device_id(id) || !matches!(action, "stop" | "resume") {
            return Err(SessionRecoveryError::InvalidIdentity);
        }
        let challenge = post_bounded(
            &self.client,
            &self.origin,
            "/agent/owner/intent/challenge",
            json!({"action":action,"device_id":id}),
            200,
            false,
        )?;
        if challenge["action"] != action || challenge["device_id"] != id {
            return Err(SessionRecoveryError::Rejected);
        }
        let nonce = challenge["nonce"]
            .as_str()
            .ok_or(SessionRecoveryError::Rejected)?;
        let generation = challenge["generation"]
            .as_u64()
            .ok_or(SessionRecoveryError::Rejected)?;
        if nonce.len() != 24
            || !nonce
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || generation >= 9_007_199_254_740_991
        {
            return Err(SessionRecoveryError::Rejected);
        }
        Ok((nonce.to_owned(), generation))
    }

    /// Explicit owner intent uses a separate signing domain and exact Worker
    /// response. A timeout, invalid proof or rejection is never success.
    pub fn owner_intent(
        &self,
        pem: &str,
        id: &str,
        action: &str,
    ) -> Result<(), SessionRecoveryError> {
        let (nonce, generation) = self.owner_challenge(id, action)?;
        let proof = crate::identity::signed_owner_intent_proof(pem, action, id, &nonce, generation)
            .map_err(|_| SessionRecoveryError::Rejected)?;
        let result = post_bounded(
            &self.client,
            &self.origin,
            "/agent/owner/intent",
            json!({"action":action,"device_id":id,"nonce":nonce,"generation":generation,"proof":proof}),
            200,
            false,
        )?;
        let expected = if action == "stop" {
            "stopped"
        } else {
            "resume_pending"
        };
        if result["status"] != expected
            || result["device_id"] != id
            || !result["idle_expires_at"]
                .as_i64()
                .is_some_and(|value| value.unsigned_abs() <= 9_007_199_254_740_991)
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

#[cfg(windows)]
mod windows_pair_store {
    use crate::session_recovery::SessionRecoveryError;
    use crate::{seal_new_windows_private_file, validate_windows_private_path};
    use std::fs::{self, OpenOptions};
    use std::io::{ErrorKind, Read, Write};
    use std::path::Path;
    pub(super) fn present(path: &Path) -> Result<bool, SessionRecoveryError> {
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
            Err(_) => Err(SessionRecoveryError::Unavailable),
        }
    }
    pub(super) fn read(path: &Path, max: u64) -> Result<Option<String>, SessionRecoveryError> {
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
    pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<(), SessionRecoveryError> {
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
}
#[cfg(windows)]
use windows_pair_store::{present, read, write_new};

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
    use crate::validate_windows_private_path;
    use std::fs;
    let invalid = || SessionRecoveryError::InvalidIdentity;
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
    let assert_no_conflicts = || -> Result<(), SessionRecoveryError> {
        for name in [
            "v2-identity.pem.owner-stopped",
            "windows-native-upgrade.json",
            "v2-identity.pem.device-id.pending",
        ] {
            if present(&directory.join(name))? {
                return Err(invalid());
            }
        }
        Ok(())
    };
    assert_no_conflicts()?;
    if !present(&mode)? {
        if present(&key)? || present(&id)? || present(&activation)? {
            return Err(invalid()); // Legacy state requires its reviewed upgrade path.
        }
        write_new(&mode, required_mode.as_bytes())?;
    }
    // Same immutable-mode file is held by pairing, re-pair and owner intent.
    let guard = lock_windows_mode(directory, required_mode)?;
    assert_no_conflicts()?;
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
    let receipts = directory.join("receipts");
    if present(&receipts)? {
        validate_windows_private_path(&receipts, true).map_err(|_| invalid())?;
    } else {
        fs::create_dir(&receipts).map_err(|_| SessionRecoveryError::Unavailable)?;
        crate::seal_new_windows_private_directory(&receipts).map_err(|_| invalid())?;
    }
    drop(guard);
    Ok(approved)
}

/// Exclusive owner lifecycle operation using the existing immutable mode
/// file. No new persistent lock or state format.
#[cfg(windows)]
pub fn lock_windows_permanent_mode(
    directory: &std::path::Path,
) -> Result<std::fs::File, SessionRecoveryError> {
    lock_windows_mode(directory, "permanent\n")
}

#[cfg(windows)]
fn lock_windows_mode(
    directory: &std::path::Path,
    expected: &str,
) -> Result<std::fs::File, SessionRecoveryError> {
    use std::io::Read;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
    crate::validate_windows_private_path(directory, true)
        .map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    let mode = directory.join("v2-identity.pem.install-mode");
    crate::validate_windows_private_path(&mode, false)
        .map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    let mut guard = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ)
        .open(mode)
        .map_err(|_| SessionRecoveryError::Unavailable)?;
    let mut saved = String::new();
    (&mut guard)
        .take(32)
        .read_to_string(&mut saved)
        .map_err(|_| SessionRecoveryError::InvalidIdentity)?;
    if saved != expected {
        return Err(SessionRecoveryError::InvalidIdentity);
    }
    Ok(guard)
}

#[cfg(windows)]
pub fn persist_windows_owner_stop(directory: &std::path::Path) -> Result<(), SessionRecoveryError> {
    let marker = directory.join("v2-identity.pem.owner-stopped");
    match read(&marker, 32)? {
        Some(saved) if saved == "stopped\n" => Ok(()),
        Some(_) => Err(SessionRecoveryError::InvalidIdentity),
        None => write_new(&marker, b"stopped\n"),
    }
}

/// Existing Windows reauthorization retains the original key. A new device
/// ID comes only from signed same-key recovery / independently approved
/// pending enrollment. The original ID remains until the stopped Task is
/// rechecked and the sealed same-volume replacement is ready.
#[cfg(windows)]
pub fn repair_windows_identity(
    directory: &std::path::Path,
    client: &PairingClient,
    name: &str,
    assert_stopped: impl FnMut() -> Result<(), SessionRecoveryError>,
    display: impl FnOnce(&PendingEnrollment),
) -> Result<String, SessionRecoveryError> {
    repair_windows_identity_with(directory, assert_stopped, |pem, pending| {
        client.pair(pem, pending, name, false, display)
    })
}

#[cfg(windows)]
fn repair_windows_identity_with(
    directory: &std::path::Path,
    mut assert_stopped: impl FnMut() -> Result<(), SessionRecoveryError>,
    resolve: impl FnOnce(&str, Option<&str>) -> Result<String, SessionRecoveryError>,
) -> Result<String, SessionRecoveryError> {
    let _guard = lock_windows_permanent_mode(directory)?;
    let invalid = || SessionRecoveryError::InvalidIdentity;
    for name in [
        "windows-native-upgrade.json",
        "v2-identity.pem.activation-pending",
    ] {
        if present(&directory.join(name))? {
            return Err(invalid());
        }
    }
    let key = directory.join("v2-identity.pem");
    let id_path = directory.join("v2-identity.pem.device-id");
    let stage = directory.join("v2-identity.pem.device-id.pending");
    let pem = read(&key, 8192)?.ok_or_else(invalid)?;
    signing_key(&pem).map_err(|_| invalid())?;
    let old = read(&id_path, 128)?.ok_or_else(invalid)?;
    let pending = read(&stage, 128)?;
    if !valid_device_id(old.trim())
        || pending
            .as_deref()
            .is_some_and(|value| !valid_device_id(value.trim()))
    {
        return Err(invalid());
    }
    assert_stopped()?;
    let approved = resolve(&pem, pending.as_deref().map(str::trim))?;
    if !valid_device_id(&approved)
        || pending
            .as_deref()
            .is_some_and(|value| value.trim() != approved)
    {
        return Err(invalid());
    }
    if read(&key, 8192)?.as_deref() != Some(&pem) || read(&id_path, 128)?.as_deref() != Some(&old) {
        return Err(invalid());
    }
    assert_stopped()?;
    if old.trim() == approved && pending.is_none() {
        return Ok(approved);
    }
    if pending.is_none() {
        write_new(&stage, format!("{approved}\n").as_bytes())?;
    }
    // If an attended operation was interrupted after staging, the next
    // attempt must reverify the same signed pending ID before promoting.
    assert_stopped()?;
    if read(&stage, 128)?.as_deref().map(str::trim) != Some(approved.as_str())
        || read(&id_path, 128)?.as_deref() != Some(&old)
        || read(&key, 8192)?.as_deref() != Some(&pem)
    {
        return Err(invalid());
    }
    std::fs::rename(&stage, &id_path).map_err(|_| SessionRecoveryError::Unavailable)?;
    crate::validate_windows_private_path(&id_path, false).map_err(|_| invalid())?;
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

    #[test]
    fn browser_approval_instruction_uses_exact_enrollment_origin_and_fragment() {
        let pem = generate_private_pem().unwrap();
        let pending = new_pending_enrollment("test", &pem, true).unwrap();
        for (endpoint, canonical) in [
            ("https://rca.lirtual.dpdns.org/", true),
            ("https://other.example/", false),
            ("https://rca.lirtual.dpdns.org:8443/", false),
        ] {
            let client = PairingClient::new(endpoint).unwrap();
            let message = client.approval_instruction(&pending, "temporary");
            assert!(message.contains(&pending.fingerprint));
            assert!(message.contains("temporary"));
            assert_eq!(
                message.contains(&format!(
                    "https://rca.lirtual.dpdns.org/pair#{}",
                    pending.code
                )),
                canonical
            );
            if !canonical {
                assert!(!message.contains(&pending.code));
                assert!(message.contains("official RCA installer"));
            }
            assert!(!message.contains(&pem));
        }
    }

    #[test]
    fn permanent_grant_evidence_is_challenge_only() {
        for valid in [true, false] {
            let (client, listener) = fixture();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let (route, request) = recv_request(&mut socket);
                assert_eq!(route, "POST /agent/owner/intent/challenge HTTP/1.1");
                assert_eq!(request, json!({"action":"stop","device_id":ID}));
                reply(
                    &mut socket,
                    "200 OK",
                    json!({"action":"stop","device_id":ID,"nonce":if valid {NONCE} else {"bad"},"generation":3}),
                );
                // Listener drops: the read-only check cannot submit an intent.
            });
            assert_eq!(client.verify_permanent_grant(ID).is_ok(), valid);
            server.join().unwrap();
        }
    }

    #[test]
    fn signed_owner_intent_checks_exact_challenge_and_result() {
        for (action, status) in [("stop", "stopped"), ("resume", "resume_pending")] {
            for valid in [true, false] {
                let (client, listener) = fixture();
                let pem = generate_private_pem().unwrap();
                let expected_pem = pem.clone();
                let server = std::thread::spawn(move || {
                    let (mut socket, _) = listener.accept().unwrap();
                    let (route, request) = recv_request(&mut socket);
                    assert_eq!(route, "POST /agent/owner/intent/challenge HTTP/1.1");
                    assert_eq!(request, json!({"action":action,"device_id":ID}));
                    reply(
                        &mut socket,
                        "200 OK",
                        json!({"action":action,"device_id":ID,"nonce":NONCE,"generation":3}),
                    );
                    let (mut socket, _) = listener.accept().unwrap();
                    let (route, request) = recv_request(&mut socket);
                    assert_eq!(route, "POST /agent/owner/intent HTTP/1.1");
                    assert_eq!(
                        request,
                        json!({"action":action,"device_id":ID,"nonce":NONCE,"generation":3,
                        "proof":crate::identity::signed_owner_intent_proof(&expected_pem, action, ID, NONCE, 3).unwrap()})
                    );
                    reply(
                        &mut socket,
                        "200 OK",
                        json!({"status":if valid {status} else {"verified"},"device_id":ID,"idle_expires_at":1795490000000_u64}),
                    );
                });
                assert_eq!(client.owner_intent(&pem, ID, action).is_ok(), valid);
                server.join().unwrap();
            }
        }
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
    fn windows_same_key_repair_retains_original_until_stopped_signed_promotion() {
        let directory = tempfile::tempdir().unwrap();
        crate::seal_new_windows_private_directory(directory.path()).unwrap();
        let root = directory.path();
        pair_windows_identity_with(root, false, |_, _| Ok(ID.to_owned())).unwrap();
        let key = root.join("v2-identity.pem");
        let original = std::fs::read_to_string(&key).unwrap();
        let id_path = root.join("v2-identity.pem.device-id");
        let stage = root.join("v2-identity.pem.device-id.pending");
        std::fs::remove_file(root.join("v2-identity.pem.activation-pending")).unwrap();
        let new_id = "123e4567-e89b-42d3-a456-426614174002";
        assert!(repair_windows_identity_with(
            root,
            || Err(SessionRecoveryError::Unavailable),
            |_, _| panic!("running Task cannot pair")
        )
        .is_err());
        assert!(repair_windows_identity_with(
            root,
            || Ok(()),
            |_, _| Err(SessionRecoveryError::Rejected)
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&id_path).unwrap().trim(), ID);
        let mut checks = 0;
        assert!(repair_windows_identity_with(
            root,
            || {
                checks += 1;
                if checks == 3 {
                    Err(SessionRecoveryError::Unavailable)
                } else {
                    Ok(())
                }
            },
            |pem, pending| {
                assert_eq!(pem, original);
                assert!(pending.is_none());
                Ok(new_id.to_owned())
            }
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&id_path).unwrap().trim(), ID);
        assert_eq!(std::fs::read_to_string(&stage).unwrap().trim(), new_id);
        repair_windows_identity_with(
            root,
            || Ok(()),
            |pem, pending| {
                assert_eq!(pem, original);
                assert_eq!(pending, Some(new_id));
                Ok(new_id.to_owned())
            },
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&id_path).unwrap().trim(), new_id);
        assert_eq!(std::fs::read_to_string(key).unwrap(), original);
        assert!(!stage.exists());
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
