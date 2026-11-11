use super::*;

use serde_json::json;

/// A 32-byte key, the shape both spellings carry.
const HEX_KEY: &str = "0101010101010101010101010101010101010101010101010101010101010101";

fn record(endpoint: &str, destination: &str) -> StoredConfig {
    serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": endpoint,
        "destination": destination,
        "requestTimeoutMs": null,
    }))
    .expect("record")
}

#[test]
fn a_hex_key_is_read_and_names_the_pubkey_it_signs_with() {
    let key = secret_key_of(HEX_KEY).expect("key");
    assert_eq!(key.verifying_key().to_bytes().len(), 32);
    // The same key parses to the same public half every time.
    let again = secret_key_of(HEX_KEY).expect("key");
    assert_eq!(
        key.verifying_key().to_bytes(),
        again.verifying_key().to_bytes()
    );
}

#[test]
fn an_nsec_key_is_read_as_the_same_key() {
    use bech32::{Bech32, Hrp};
    let bytes: [u8; 32] = hex::decode(HEX_KEY).expect("hex").try_into().expect("32");
    let nsec = bech32::encode::<Bech32>(Hrp::parse("nsec").expect("hrp"), &bytes).expect("encode");

    let from_hex = secret_key_of(HEX_KEY).expect("hex key");
    let from_nsec = secret_key_of(&nsec).expect("nsec key");
    assert_eq!(
        from_hex.verifying_key().to_bytes(),
        from_nsec.verifying_key().to_bytes()
    );
}

#[test]
fn a_key_that_is_not_thirty_two_bytes_is_refused() {
    assert!(secret_key_of("abcd").is_err());
    assert!(secret_key_of("").is_err());
    assert!(secret_key_of(&"z".repeat(64)).is_err());
}

#[test]
fn an_event_is_signed_over_its_own_id() {
    use k256::schnorr::signature::hazmat::PrehashVerifier;

    let key = secret_key_of(HEX_KEY).expect("key");
    let signed = sign_event(
        &key,
        GROUP_MESSAGE_KIND,
        vec![vec!["h".to_string(), "chan-1".to_string()]],
        "hello",
        1_700_000_000,
    )
    .expect("signed");

    // The id is the hash of the canonical array, not of the pretty JSON.
    let pubkey = hex::encode(key.verifying_key().to_bytes());
    let canonical = serde_json::to_string(&json!([
        0,
        pubkey,
        1_700_000_000u64,
        GROUP_MESSAGE_KIND,
        [["h", "chan-1"]],
        "hello"
    ]))
    .expect("canonical");
    let expected: [u8; 32] = Sha256::digest(canonical.as_bytes()).into();
    assert_eq!(signed.id, hex::encode(expected));

    // And the signature verifies against that id under the event's pubkey.
    let sig_bytes = hex::decode(signed.event["sig"].as_str().expect("sig")).expect("hex");
    let signature =
        k256::schnorr::Signature::try_from(sig_bytes.as_slice()).expect("signature shape");
    key.verifying_key()
        .verify_prehash(&expected, &signature)
        .expect("the signature covers the id");
}

#[test]
fn the_event_carries_the_channel_in_its_h_tag() {
    let key = secret_key_of(HEX_KEY).expect("key");
    let signed = sign_event(
        &key,
        GROUP_MESSAGE_KIND,
        vec![vec!["h".to_string(), "chan-9".to_string()]],
        "text",
        1,
    )
    .expect("signed");

    assert_eq!(signed.event["kind"], json!(GROUP_MESSAGE_KIND));
    assert_eq!(signed.event["content"], json!("text"));
    assert_eq!(signed.event["tags"], json!([["h", "chan-9"]]));
    assert_eq!(
        signed.event["pubkey"].as_str().map(str::len),
        Some(64),
        "the pubkey is x-only hex"
    );
}

#[test]
fn an_endpoint_that_is_not_a_websocket_is_refused() {
    assert!(check_endpoint("https://buzz.example.com").is_err());
    assert!(check_endpoint("ws://127.0.0.1:3000").is_ok());
    assert!(check_endpoint("wss://buzz.example.com").is_ok());
}

#[test]
fn a_channel_id_with_whitespace_is_refused() {
    assert!(channel_of("").is_err());
    assert!(channel_of("the general channel").is_err());
    assert_eq!(channel_of(" 9f0c1a ").expect("id"), "9f0c1a");
}

#[test]
fn a_record_of_another_format_or_version_is_refused() {
    let mut wrong_format = record("wss://relay", "chan");
    wrong_format.format = "something-else".into();
    assert!(check_record(&wrong_format).is_err());

    let mut wrong_version = record("wss://relay", "chan");
    wrong_version.version = 99;
    assert!(check_record(&wrong_version).is_err());

    assert!(check_record(&record("wss://relay", "chan")).is_ok());
}

#[test]
fn an_adapter_needs_a_usable_key_and_a_channel() {
    assert!(configured_adapter(&record("wss://relay", "chan"), HEX_KEY).is_ok());
    assert!(configured_adapter(&record("wss://relay", ""), HEX_KEY).is_err());
    assert!(configured_adapter(&record("https://relay", "chan"), HEX_KEY).is_err());
    assert!(configured_adapter(&record("wss://relay", "chan"), "not-a-key").is_err());
}
