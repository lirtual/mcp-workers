//! Independent expected values from Node 24's signedSessionProof / signedOwnerIntentProof.
use rca_native_agent::identity::{signed_owner_intent_proof, signed_session_proof};

mod common;
const DEVICE_ID: &str = "12345678-1234-1234-1234-123456789abc";
const NONCE: &str = "ABCDEFGHIJKLMNOPQRSTUVWX";

#[test]
fn node24_ed25519_pkcs8_spki_and_session_transcript_match() {
    let actual = signed_session_proof(&common::test_pem(), DEVICE_ID, NONCE).unwrap();
    assert_eq!(
        actual.public_key,
        "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="
    );
    assert_eq!(
        actual.proof,
        "XNSFWbbMsKNoaFInjZPwOeo543Cw3RDICp9di8gFUhlZSksWdzWYp6hnWFoCzAbCm3VAH-mNK1LZCUlbqp_6AQ"
    );
}

#[test]
fn node24_owner_stop_transcript_matches_and_invalid_challenges_fail() {
    assert_eq!(
        signed_owner_intent_proof(&common::test_pem(), "stop", DEVICE_ID, NONCE, 7).unwrap(),
        "pvU3moTM2D2NIPdBTqxS1qWzeINwPY7LdyBtPsYnuZ40HF3HvvRlvxyZTD3-ElUlhgGc37tIP8csEM1DUao6DQ",
    );
    assert!(signed_session_proof(&common::test_pem(), DEVICE_ID, "short").is_err());
    assert!(signed_session_proof(&common::test_pem(), "not-a-uuid", NONCE).is_err());
    assert!(signed_owner_intent_proof(&common::test_pem(), "revoke", DEVICE_ID, NONCE, 7).is_err());
    assert!(signed_owner_intent_proof(
        &common::test_pem(),
        "stop",
        DEVICE_ID,
        NONCE,
        9_007_199_254_740_991
    )
    .is_err());
}
