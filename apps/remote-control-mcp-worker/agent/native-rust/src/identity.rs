//! Existing signed-device interface. No new owner authorization model.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
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
    #[error("could not generate device identity")]
    KeyGeneration,
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

pub(crate) fn signing_key(pem: &str) -> Result<SigningKey, IdentityError> {
    SigningKey::from_pkcs8_pem(pem).map_err(|_| IdentityError::InvalidPrivateKey)
}

pub(crate) fn public_key(sk: &SigningKey) -> Result<String, IdentityError> {
    let spki = sk
        .verifying_key()
        .to_public_key_der()
        .map_err(|_| IdentityError::PublicKeyEncoding)?;
    Ok(STANDARD.encode(spki.as_bytes()))
}

pub(crate) fn new_private_key_pem() -> Result<String, IdentityError> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|_| IdentityError::KeyGeneration)?;
    let key = SigningKey::from_bytes(&seed);
    seed.fill(0);
    key.to_pkcs8_pem(pkcs8::LineEnding::LF)
        .map(|pem| pem.to_string())
        .map_err(|_| IdentityError::KeyGeneration)
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

pub fn signed_secure_input_owner_intent_proof(
    pem: &str,
    request_id: &str,
    device_id: &str,
    nonce: &str,
    generation: u64,
    target_binding: &str,
    target_confirmed: bool,
    production_authorized: bool,
) -> Result<String, IdentityError> {
    let valid_binding = target_binding.len() == 43
        && target_binding
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-');
    if !valid_device_id(request_id)
        || !valid_device_id(device_id)
        || !valid_nonce(nonce)
        || generation >= 9_007_199_254_740_991
        || !valid_binding
    {
        return Err(IdentityError::InvalidChallenge);
    }
    let key = signing_key(pem)?;
    let public_key = public_key(&key)?;
    let transcript = format!(
        "remote-control:v2:secure-input-owner-intent:v1:{request_id}:{device_id}:{generation}:{target_binding}:{nonce}:{}:{}:{public_key}",
        u8::from(target_confirmed),
        u8::from(production_authorized),
    );
    Ok(URL_SAFE_NO_PAD.encode(key.sign(transcript.as_bytes()).to_bytes()))
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

#[cfg(test)]
mod secure_input_owner_intent_tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::Verifier;

    #[test]
    fn secure_input_owner_signature_binds_request_target_and_separate_production_intent() {
        let pem = new_private_key_pem().unwrap();
        let request = "12345678-1234-1234-1234-123456789abc";
        let device = "abcdefab-cdef-abcd-efab-cdefabcdefab";
        let nonce = "abcdefghijklmnopqrstuvwx";
        let binding = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
        let proof = signed_secure_input_owner_intent_proof(
            &pem, request, device, nonce, 7, binding, true, true,
        )
        .unwrap();
        let signature = URL_SAFE_NO_PAD.decode(&proof).unwrap();
        let key = signing_key(&pem).unwrap();
        let public = public_key(&key).unwrap();
        let transcript = format!(
            "remote-control:v2:secure-input-owner-intent:v1:{request}:{device}:7:{binding}:{nonce}:1:1:{public}"
        );
        let raw = ed25519_dalek::Signature::from_slice(&signature).unwrap();
        key.verifying_key()
            .verify(transcript.as_bytes(), &raw)
            .unwrap();

        assert_ne!(
            proof,
            signed_secure_input_owner_intent_proof(
                &pem, request, device, nonce, 7, binding, true, false,
            )
            .unwrap()
        );
        assert!(signed_secure_input_owner_intent_proof(
            &pem, "bad", device, nonce, 7, binding, true, true,
        )
        .is_err());
        assert!(signed_secure_input_owner_intent_proof(
            &pem, request, device, nonce, 7, "short", true, true,
        )
        .is_err());
    }
}
