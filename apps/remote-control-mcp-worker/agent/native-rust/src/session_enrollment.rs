//! GitHub-hosted Session's disposable, attempt-scoped enrollment identity.
//! No OIDC transport, registration or installed/personal Agent state is handled here.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
use ed25519_dalek::{Signer, SigningKey};
use pkcs8::LineEnding;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const ENROLLMENT_PREFIX: &str = "remote-control:github-session-enrollment:v1:";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPhysicalAttempt {
    pub attempt_id: String,
    pub github_run_id: u64,
    pub github_run_attempt: u64,
    pub workflow_name: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SessionDeviceIdentity {
    pub attempt: SessionPhysicalAttempt,
    pub public_key: String,
    pub private_key_pem: String,
}

#[derive(Debug, Error)]
pub enum EnrollmentError {
    #[error("invalid physical Session Attempt")]
    InvalidAttempt,
    #[error("Session identity belongs to another Attempt or has a mismatched key")]
    InvalidIdentity,
    #[error("invalid enrollment nonce")]
    InvalidNonce,
    #[error("Session identity cryptography unavailable")]
    Cryptography,
    #[error("untrusted Session identity state")]
    UntrustedStore,
    #[error("Session identity filesystem unavailable")]
    Io(#[from] std::io::Error),
}

fn valid_attempt(attempt: &SessionPhysicalAttempt) -> bool {
    crate::identity::valid_device_id(&attempt.attempt_id)
        && (1..=MAX_SAFE_INTEGER).contains(&attempt.github_run_id)
        && (1..=MAX_SAFE_INTEGER).contains(&attempt.github_run_attempt)
        && matches!(attempt.workflow_name.as_str(), "ubuntu" | "windows")
}

fn public_key(key: &SigningKey) -> Result<String, EnrollmentError> {
    let der = key
        .verifying_key()
        .to_public_key_der()
        .map_err(|_| EnrollmentError::Cryptography)?;
    Ok(STANDARD.encode(der.as_bytes()))
}

pub fn new_session_identity(
    attempt: &SessionPhysicalAttempt,
) -> Result<SessionDeviceIdentity, EnrollmentError> {
    if !valid_attempt(attempt) {
        return Err(EnrollmentError::InvalidAttempt);
    }
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|_| EnrollmentError::Cryptography)?;
    let key = SigningKey::from_bytes(&seed);
    seed.fill(0);
    let private_key_pem = key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|_| EnrollmentError::Cryptography)?
        .to_string();
    Ok(SessionDeviceIdentity {
        attempt: attempt.clone(),
        public_key: public_key(&key)?,
        private_key_pem,
    })
}

pub fn validate_session_identity(
    identity: &SessionDeviceIdentity,
    attempt: &SessionPhysicalAttempt,
) -> Result<(), EnrollmentError> {
    if !valid_attempt(attempt) {
        return Err(EnrollmentError::InvalidAttempt);
    }
    if &identity.attempt != attempt {
        return Err(EnrollmentError::InvalidIdentity);
    }
    let key = SigningKey::from_pkcs8_pem(&identity.private_key_pem)
        .map_err(|_| EnrollmentError::InvalidIdentity)?;
    if public_key(&key)? != identity.public_key {
        return Err(EnrollmentError::InvalidIdentity);
    }
    Ok(())
}

pub fn sign_session_enrollment_nonce(
    identity: &SessionDeviceIdentity,
    nonce: &str,
) -> Result<String, EnrollmentError> {
    validate_session_identity(identity, &identity.attempt)?;
    if !(16..=128).contains(&nonce.len())
        || !nonce
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(EnrollmentError::InvalidNonce);
    }
    let attempt = &identity.attempt;
    let transcript = format!(
        "{ENROLLMENT_PREFIX}{}:{}:{}:{}:{}:{}",
        attempt.attempt_id,
        attempt.github_run_id,
        attempt.github_run_attempt,
        attempt.workflow_name,
        identity.public_key,
        nonce
    );
    let key = SigningKey::from_pkcs8_pem(&identity.private_key_pem)
        .map_err(|_| EnrollmentError::InvalidIdentity)?;
    Ok(STANDARD.encode(key.sign(transcript.as_bytes()).to_bytes()))
}

#[cfg(target_os = "linux")]
mod linux_store {
    use super::*;
    use std::fs::{self, DirBuilder, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    use std::path::{Path, PathBuf};
    use std::thread;
    use std::time::Duration;

    fn safe_directory(path: &Path, private: bool) -> Result<fs::Metadata, EnrollmentError> {
        let meta = fs::symlink_metadata(path).map_err(|_| EnrollmentError::UntrustedStore)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(EnrollmentError::UntrustedStore);
        }
        if private && (meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0) {
            return Err(EnrollmentError::UntrustedStore);
        }
        Ok(meta)
    }

    fn safe_runner_root(root: &Path) -> Result<(), EnrollmentError> {
        if !root.is_absolute() {
            return Err(EnrollmentError::UntrustedStore);
        }
        for ancestor in root.ancestors() {
            safe_directory(ancestor, false)?;
        }
        let meta = safe_directory(root, false)?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 {
            return Err(EnrollmentError::UntrustedStore);
        }
        Ok(())
    }

    fn read_verified(
        file: &Path,
        attempt: &SessionPhysicalAttempt,
    ) -> Result<SessionDeviceIdentity, EnrollmentError> {
        let mut meta = fs::symlink_metadata(file)?;
        // A publisher briefly has two links while removing its private staging name.
        for _ in 0..40 {
            if !meta.is_file()
                || meta.file_type().is_symlink()
                || meta.uid() != unsafe { libc::geteuid() }
                || meta.mode() & 0o077 != 0
                || meta.len() > 4096
                || meta.nlink() != 2
            {
                break;
            }
            thread::sleep(Duration::from_millis(10));
            meta = fs::symlink_metadata(file)?;
        }
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
            || meta.nlink() != 1
            || meta.len() > 4096
        {
            return Err(EnrollmentError::UntrustedStore);
        }
        let handle = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(file)?;
        let opened = handle.metadata()?;
        if opened.dev() != meta.dev() || opened.ino() != meta.ino() {
            return Err(EnrollmentError::UntrustedStore);
        }
        let mut bytes = Vec::new();
        handle.take(4097).read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(EnrollmentError::UntrustedStore);
        }
        let after = fs::symlink_metadata(file)?;
        if after.dev() != opened.dev()
            || after.ino() != opened.ino()
            || after.nlink() != 1
            || after.len() != bytes.len() as u64
        {
            return Err(EnrollmentError::UntrustedStore);
        }
        let identity: SessionDeviceIdentity =
            serde_json::from_slice(&bytes).map_err(|_| EnrollmentError::UntrustedStore)?;
        validate_session_identity(&identity, attempt)?;
        Ok(identity)
    }

    pub(super) fn load_or_create(
        runner_temp: &Path,
        attempt: &SessionPhysicalAttempt,
    ) -> Result<(PathBuf, SessionDeviceIdentity), EnrollmentError> {
        if !valid_attempt(attempt) {
            return Err(EnrollmentError::InvalidAttempt);
        }
        safe_runner_root(runner_temp)?;
        let directory = runner_temp.join("session-rca");
        match DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(EnrollmentError::UntrustedStore),
        }
        safe_directory(&directory, true)?;
        let file = directory.join("identity.json");
        match read_verified(&file, attempt) {
            Ok(identity) => return Ok((file, identity)),
            Err(EnrollmentError::Io(ref err)) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
        let identity = new_session_identity(attempt)?;
        let mut random_name = [0u8; 16];
        getrandom::fill(&mut random_name).map_err(|_| EnrollmentError::Cryptography)?;
        let temporary = directory.join(format!("identity-{}.tmp", {
            random_name
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        }));
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        handle.write_all(
            &serde_json::to_vec(&identity).map_err(|_| EnrollmentError::UntrustedStore)?,
        )?;
        handle.sync_all()?;
        drop(handle);
        let published = fs::hard_link(&temporary, &file);
        fs::remove_file(&temporary)?;
        match published {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(EnrollmentError::Io(err)),
        }
        File::open(&directory)?.sync_all()?;
        Ok((file.clone(), read_verified(&file, attempt)?))
    }

    /// Child mode must never mint a new key if the one-shot registration
    /// parent's physical Attempt identity is absent or tampered with.
    pub(super) fn load_existing(
        runner_temp: &Path,
        attempt: &SessionPhysicalAttempt,
    ) -> Result<(PathBuf, SessionDeviceIdentity), EnrollmentError> {
        if !valid_attempt(attempt) {
            return Err(EnrollmentError::InvalidAttempt);
        }
        safe_runner_root(runner_temp)?;
        let directory = runner_temp.join("session-rca");
        safe_directory(&directory, true)?;
        let file = directory.join("identity.json");
        Ok((file.clone(), read_verified(&file, attempt)?))
    }
}

#[cfg(target_os = "linux")]
pub fn load_or_create_linux_session_identity(
    runner_temp: &std::path::Path,
    attempt: &SessionPhysicalAttempt,
) -> Result<(std::path::PathBuf, SessionDeviceIdentity), EnrollmentError> {
    linux_store::load_or_create(runner_temp, attempt)
}

#[cfg(target_os = "linux")]
pub fn load_existing_linux_session_identity(
    runner_temp: &std::path::Path,
    attempt: &SessionPhysicalAttempt,
) -> Result<(std::path::PathBuf, SessionDeviceIdentity), EnrollmentError> {
    linux_store::load_existing(runner_temp, attempt)
}

#[cfg(windows)]
mod windows_store {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};

    fn safe_directory(path: &Path) -> Result<(), EnrollmentError> {
        let meta = fs::symlink_metadata(path).map_err(|_| EnrollmentError::UntrustedStore)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(EnrollmentError::UntrustedStore);
        }
        crate::validate_windows_private_path(path, true)
            .map_err(|_| EnrollmentError::UntrustedStore)
    }

    fn safe_runner_root(root: &Path) -> Result<(), EnrollmentError> {
        if !root.is_absolute() {
            return Err(EnrollmentError::UntrustedStore);
        }
        safe_directory(root)
    }

    fn read_verified(
        file: &Path,
        attempt: &SessionPhysicalAttempt,
    ) -> Result<SessionDeviceIdentity, EnrollmentError> {
        let meta = fs::symlink_metadata(file).map_err(|_| EnrollmentError::UntrustedStore)?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4096 {
            return Err(EnrollmentError::UntrustedStore);
        }
        crate::validate_windows_private_path(file, false)
            .map_err(|_| EnrollmentError::UntrustedStore)?;
        let handle = File::open(file)?;
        let opened = handle.metadata()?;
        if !opened.is_file() || opened.len() > 4096 || opened.len() != meta.len() {
            return Err(EnrollmentError::UntrustedStore);
        }
        let mut bytes = Vec::new();
        handle.take(4097).read_to_end(&mut bytes)?;
        if bytes.is_empty() || bytes.len() > 4096 {
            return Err(EnrollmentError::UntrustedStore);
        }
        crate::validate_windows_private_path(file, false)
            .map_err(|_| EnrollmentError::UntrustedStore)?;
        let after = fs::symlink_metadata(file).map_err(|_| EnrollmentError::UntrustedStore)?;
        if !after.is_file() || after.file_type().is_symlink() || after.len() != bytes.len() as u64 {
            return Err(EnrollmentError::UntrustedStore);
        }
        let identity: SessionDeviceIdentity =
            serde_json::from_slice(&bytes).map_err(|_| EnrollmentError::UntrustedStore)?;
        validate_session_identity(&identity, attempt)?;
        Ok(identity)
    }

    pub(super) fn load_or_create(
        runner_temp: &Path,
        attempt: &SessionPhysicalAttempt,
    ) -> Result<(PathBuf, SessionDeviceIdentity), EnrollmentError> {
        if !valid_attempt(attempt) {
            return Err(EnrollmentError::InvalidAttempt);
        }
        safe_runner_root(runner_temp)?;
        let directory = runner_temp.join("session-rca");
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(EnrollmentError::UntrustedStore),
        }
        safe_directory(&directory)?;
        let file = directory.join("identity.json");
        match read_verified(&file, attempt) {
            Ok(identity) => return Ok((file, identity)),
            Err(EnrollmentError::Io(ref error)) if error.kind() == std::io::ErrorKind::NotFound => {
            }
            Err(EnrollmentError::UntrustedStore) => match fs::symlink_metadata(&file) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(EnrollmentError::UntrustedStore),
            },
            Err(error) => return Err(error),
        }
        let identity = new_session_identity(attempt)?;
        let bytes = serde_json::to_vec(&identity).map_err(|_| EnrollmentError::UntrustedStore)?;
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)?;
        crate::validate_windows_private_path(&file, false)
            .map_err(|_| EnrollmentError::UntrustedStore)?;
        handle.write_all(&bytes)?;
        handle.sync_all()?;
        drop(handle);
        safe_directory(&directory)?;
        Ok((file.clone(), read_verified(&file, attempt)?))
    }

    pub(super) fn load_existing(
        runner_temp: &Path,
        attempt: &SessionPhysicalAttempt,
    ) -> Result<(PathBuf, SessionDeviceIdentity), EnrollmentError> {
        if !valid_attempt(attempt) {
            return Err(EnrollmentError::InvalidAttempt);
        }
        safe_runner_root(runner_temp)?;
        let directory = runner_temp.join("session-rca");
        safe_directory(&directory)?;
        let file = directory.join("identity.json");
        Ok((file.clone(), read_verified(&file, attempt)?))
    }
}

#[cfg(windows)]
pub fn load_or_create_windows_session_identity(
    runner_temp: &std::path::Path,
    attempt: &SessionPhysicalAttempt,
) -> Result<(std::path::PathBuf, SessionDeviceIdentity), EnrollmentError> {
    windows_store::load_or_create(runner_temp, attempt)
}

#[cfg(windows)]
pub fn load_existing_windows_session_identity(
    runner_temp: &std::path::Path,
    attempt: &SessionPhysicalAttempt,
) -> Result<(std::path::PathBuf, SessionDeviceIdentity), EnrollmentError> {
    windows_store::load_existing(runner_temp, attempt)
}

#[cfg(all(test, windows))]
mod windows_store_tests {
    use super::*;
    use std::fs;

    fn attempt() -> SessionPhysicalAttempt {
        SessionPhysicalAttempt {
            attempt_id: "123e4567-e89b-42d3-a456-426614174001".into(),
            github_run_id: 123,
            github_run_attempt: 1,
            workflow_name: "windows".into(),
        }
    }

    #[test]
    fn windows_session_identity_is_private_and_attempt_bound() {
        let runner_temp = tempfile::tempdir().unwrap();
        let attempt = attempt();
        let (path, first) =
            load_or_create_windows_session_identity(runner_temp.path(), &attempt).unwrap();
        let (loaded_path, second) =
            load_existing_windows_session_identity(runner_temp.path(), &attempt).unwrap();
        assert_eq!(path, loaded_path);
        assert_eq!(first.attempt, attempt);
        assert_eq!(second.attempt, attempt);
        assert_eq!(first.public_key, second.public_key);

        let mut other = attempt.clone();
        other.github_run_attempt += 1;
        assert!(matches!(
            load_existing_windows_session_identity(runner_temp.path(), &other),
            Err(EnrollmentError::UntrustedStore | EnrollmentError::InvalidIdentity)
        ));
    }

    #[test]
    fn windows_session_identity_tampering_fails_closed() {
        let runner_temp = tempfile::tempdir().unwrap();
        let attempt = attempt();
        let (path, _) =
            load_or_create_windows_session_identity(runner_temp.path(), &attempt).unwrap();
        fs::write(&path, b"{}").unwrap();
        assert!(matches!(
            load_existing_windows_session_identity(runner_temp.path(), &attempt),
            Err(EnrollmentError::UntrustedStore | EnrollmentError::InvalidIdentity)
        ));
    }
}
