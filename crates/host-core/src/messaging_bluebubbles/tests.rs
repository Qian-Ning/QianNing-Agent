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
fn the_send_url_carries_the_password_as_a_query_parameter() {
    let adapter = configured_adapter(
        &record("http://192.168.1.20:1234", "iMessage;-;+15551234567"),
        "server-password",
        true,
    )
    .expect("adapter");
    assert_eq!(
        adapter.send_url.as_str(),
        "http://192.168.1.20:1234/api/v1/message/text?guid=server-password"
    );
}

#[test]
fn an_empty_destination_is_refused() {
    let Err(error) = configured_adapter(&record("http://192.168.1.20:1234", "  "), "p", true)
    else {
        panic!("an empty destination must be refused");
    };
    assert!(format!("{error}").contains("chat"), "{error}");
}

#[test]
fn an_empty_password_is_refused() {
    let Err(error) = configured_adapter(
        &record("http://192.168.1.20:1234", "iMessage;-;+1555"),
        "   ",
        true,
    ) else {
        panic!("an empty password must be refused");
    };
    assert!(format!("{error}").contains("password"), "{error}");
}

#[test]
fn a_foreign_record_is_refused() {
    let mut record = record("http://192.168.1.20:1234", "iMessage;-;+1555");
    record.format = "pi-desktop-messaging-something-else".into();
    let Err(error) = configured_adapter(&record, "p", true) else {
        panic!("a foreign record must be refused");
    };
    assert!(format!("{error}").contains(CODE), "{error}");
}

#[test]
fn the_guid_is_read_from_the_wrapped_answer() {
    assert_eq!(
        message_guid_in(r#"{"status":200,"message":"ok","data":{"guid":"abc-1"}}"#),
        Some("abc-1".to_string())
    );
    assert_eq!(
        message_guid_in(r#"{"status":200,"data":[{"guid":"def-2"}]}"#),
        Some("def-2".to_string())
    );
    assert_eq!(message_guid_in("not json"), None);
}

#[test]
fn a_refusal_names_the_bridge_s_reason() {
    let detail = refusal_detail(
        StatusCode::UNAUTHORIZED,
        r#"{"status":401,"message":"unauthorized","error":{"type":"auth","error":"Invalid password"}}"#,
    );
    assert!(detail.contains("401"), "{detail}");
    assert!(detail.contains("Invalid password"), "{detail}");
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
fn registration_without_a_password_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    db.set_setting(
        "app",
        &json!({ SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": "http://192.168.1.20:1234",
            "destination": "iMessage;-;+1555",
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    let Err(error) = register(&mut registry, &db, &secrets) else {
        panic!("a configured channel without its credential must be an error");
    };

    assert!(format!("{error}").contains("password"), "{error}");
}
