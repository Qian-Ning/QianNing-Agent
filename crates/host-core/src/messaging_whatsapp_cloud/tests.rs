use super::*;

use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::AdapterRegistry;
use crate::secrets::SecretStore;

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
fn the_send_url_is_the_endpoint_plus_messages() {
    let adapter = configured_adapter(
        &record("https://graph.facebook.com/v21.0/999888777", "15551234567"),
        "token",
        true,
    )
    .expect("adapter");
    assert_eq!(
        adapter.send_url.as_str(),
        "https://graph.facebook.com/v21.0/999888777/messages"
    );
    assert_eq!(adapter.recipient, "15551234567");
}

#[test]
fn a_recipient_with_a_plus_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://graph.facebook.com/v21.0/999888777", "+15551234567"),
        "token",
        true,
    ) else {
        panic!("a number with a plus must be refused");
    };
    assert!(format!("{error}").contains("digits only"), "{error}");
}

#[test]
fn an_empty_access_token_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://graph.facebook.com/v21.0/999888777", "15551234567"),
        "  ",
        true,
    ) else {
        panic!("an empty token must be refused");
    };
    assert!(format!("{error}").contains("access token"), "{error}");
}

#[test]
fn a_foreign_record_is_refused() {
    let mut record = record("https://graph.facebook.com/v21.0/999888777", "15551234567");
    record.format = "pi-desktop-messaging-something-else".into();
    let Err(error) = configured_adapter(&record, "token", true) else {
        panic!("a foreign record must be refused");
    };
    assert!(format!("{error}").contains(CODE), "{error}");
}

#[test]
fn the_sent_message_id_is_read_from_the_answer() {
    assert_eq!(
        message_id_in(r#"{"messaging_product":"whatsapp","messages":[{"id":"wamid.XYZ"}]}"#),
        Some("wamid.XYZ".to_string())
    );
    assert_eq!(message_id_in(r#"{"messages":[]}"#), None);
    assert_eq!(message_id_in("not json"), None);
}

#[test]
fn a_refusal_names_the_status_and_meta_s_reason() {
    let detail = refusal_detail(
        StatusCode::UNAUTHORIZED,
        r#"{"error":{"message":"Invalid OAuth access token","code":190}}"#,
    );
    assert!(detail.contains("401"), "{detail}");
    assert!(detail.contains("Invalid OAuth access token"), "{detail}");
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
fn registration_without_an_access_token_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    db.set_setting(
        "app",
        &json!({ SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": "https://graph.facebook.com/v21.0/999888777",
            "destination": "15551234567",
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    let Err(error) = register(&mut registry, &db, &secrets) else {
        panic!("a configured channel without its credential must be an error");
    };

    assert!(format!("{error}").contains("access token"), "{error}");
}
