use super::*;

use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::AdapterRegistry;
use crate::secrets::SecretStore;

/// A syntactically valid service account whose key is deliberately unusable.
///
/// The happy path of the assertion — an RS256 signature Google accepts — cannot
/// be exercised without a real key, and a real key has no place in a repository.
/// What is exercised here is everything around it: parsing, refusal, URL
/// building, and the fact that an unusable key is a terminal refusal rather than
/// a panic.
fn service_account_with_unusable_key() -> String {
    let body = base64::engine::general_purpose::STANDARD.encode(b"not a pkcs8 key");
    json!({
        "client_email": "chat-bot@example.iam.gserviceaccount.com",
        "private_key": format!("-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----\n"),
        "token_uri": "https://oauth2.googleapis.com/token",
    })
    .to_string()
}

fn record(endpoint: &str, destination: &str) -> StoredConfig {
    serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": endpoint,
        "destination": destination,
    }))
    .expect("record")
}

#[test]
fn a_service_account_is_parsed_and_its_pem_decoded() {
    let account = parse_service_account(&service_account_with_unusable_key()).expect("account");
    assert_eq!(
        account.client_email,
        "chat-bot@example.iam.gserviceaccount.com"
    );
    assert_eq!(account.token_uri, "https://oauth2.googleapis.com/token");
    assert_eq!(account.private_key, b"not a pkcs8 key");
}

#[test]
fn a_service_account_without_its_fields_is_refused() {
    let Err(error) = parse_service_account("{}") else {
        panic!("a service account without fields must be refused");
    };
    assert!(format!("{error}").contains("client_email"), "{error}");
}

#[test]
fn a_private_key_that_is_not_base64_is_refused() {
    let raw = json!({
        "client_email": "chat-bot@example.iam.gserviceaccount.com",
        "private_key": "-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----",
    })
    .to_string();
    let Err(error) = parse_service_account(&raw) else {
        panic!("a private key that is not base64 must be refused");
    };
    assert!(format!("{error}").contains("base64"), "{error}");
}

#[test]
fn the_send_url_names_the_space() {
    let adapter = configured_adapter(
        &record("https://chat.googleapis.com", "spaces/AAAA1111"),
        &service_account_with_unusable_key(),
        true,
    )
    .expect("adapter");
    assert_eq!(
        adapter.send_url.as_str(),
        "https://chat.googleapis.com/v1/spaces/AAAA1111/messages"
    );
}

#[test]
fn an_unusable_key_is_refused_when_the_assertion_is_signed() {
    let account = parse_service_account(&service_account_with_unusable_key()).expect("account");
    let Err(error) = signed_assertion(&account) else {
        panic!("an unusable key must be refused");
    };
    assert!(format!("{error}").contains("RSA"), "{error}");
}

#[test]
fn an_empty_space_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://chat.googleapis.com", "   "),
        &service_account_with_unusable_key(),
        true,
    ) else {
        panic!("an empty space must be refused");
    };
    assert!(format!("{error}").contains("space"), "{error}");
}

#[test]
fn a_foreign_record_is_refused() {
    let mut record = record("https://chat.googleapis.com", "spaces/A");
    record.format = "pi-desktop-messaging-something-else".into();
    let Err(error) = configured_adapter(&record, &service_account_with_unusable_key(), true) else {
        panic!("a foreign record must be refused");
    };
    assert!(format!("{error}").contains(CODE), "{error}");
}

#[test]
fn registration_without_a_record_registers_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    let mut registry = AdapterRegistry::default();

    register(&mut registry, &db, &secrets).expect("no record is not an error");

    assert!(registry.get(CHANNEL).is_none());
}

#[test]
fn registration_with_a_record_but_no_service_account_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    db.set_setting(
        "app",
        &json!({ SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": "https://chat.googleapis.com",
            "destination": "spaces/A",
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    let Err(error) = register(&mut registry, &db, &secrets) else {
        panic!("a configured channel without its credential must be an error");
    };

    assert!(format!("{error}").contains("service account"), "{error}");
}
