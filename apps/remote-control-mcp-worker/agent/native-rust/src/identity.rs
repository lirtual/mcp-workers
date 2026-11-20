//! Existing signed-device interface. No new owner authorization model.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePublicKey};
use ed25519_dalek::{Signer, SigningKey};
use thiserror::Error;

const SESSION_DOMAIN: &str = "remote-control:v2:session:";
const OWNER_DOMAIN: &str = "remote-control:v2:owner-intent:v1:";

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("invalid device session challenge")]
    InvalidChallenge,
    #[error("invalid Ed25519 PKCS#8 identity")]
    InvalidPrivateKey,
    #[error("could not encode Ed25519 SPKI public key")]
    PublicKeyEncoding,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SessionProof {
    pub proof: String,
    pub public_key: String,
}

pub fn valid_device_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        })
}

fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 24
        && nonce
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn signing_key(pem: &str) -> Result<SigningKey, IdentityError> {
    SigningKey::from_pkcs8_pem(pem).map_err(|_| IdentityError::InvalidPrivateKey)
}

fn public_key(sk: &SigningKey) -> Result<String, IdentityError> {
    let spki = sk
        .verifying_key()
        .to_public_key_der()
        .map_err(|_| IdentityError::PublicKeyEncoding)?;
    Ok(STANDARD.encode(spki.as_bytes()))
}

pub fn signed_session_proof(
    pem: &str,
    device_id: &str,
    nonce: &str,
) -> Result<SessionProof, IdentityError> {
    if !valid_device_id(device_id) || !valid_nonce(nonce) {
        return Err(IdentityError::InvalidChallenge);
    }
    let key = signing_key(pem)?;
    let public_key = public_key(&key)?;
    let transcript = format!("{SESSION_DOMAIN}{device_id}:{nonce}:{public_key}");
    let signature = key.sign(transcript.as_bytes());
    Ok(SessionProof {
        proof: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        public_key,
    })
}

pub fn signed_owner_intent_proof(
    pem: &str,
    action: &str,
    device_id: &str,
    nonce: &str,
    generation: u64,
) -> Result<String, IdentityError> {
    if !["stop", "resume"].contains(&action)
        || !valid_device_id(device_id)
        || !valid_nonce(nonce)
        || generation >= 9_007_199_254_740_991
    {
        return Err(IdentityError::InvalidChallenge);
    }
    let key = signing_key(pem)?;
    let public_key = public_key(&key)?;
    let transcript =
        format!("{OWNER_DOMAIN}{action}:{device_id}:{generation}:{nonce}:{public_key}");
    Ok(URL_SAFE_NO_PAD.encode(key.sign(transcript.as_bytes()).to_bytes()))
}
