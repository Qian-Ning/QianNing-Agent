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
fn the_activity_url_is_the_service_url_plus_the_conversation() {
    let adapter = configured_adapter(
        &record(
            "https://smba.trafficmanager.net/emea/",
            "a:1abcdefghijklmnop",
        ),
        "app-id",
        "app-password",
        true,
    )
    .expect("adapter");
    assert_eq!(
        adapter.send_url.as_str(),
        "https://smba.trafficmanager.net/emea/v3/conversations/a:1abcdefghijklmnop/activities"
    );
}

#[test]
fn a_conversation_that_is_not_one_path_segment_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://smba.trafficmanager.net/emea/", "a:1/../../admin"),
        "app-id",
        "app-password",
        true,
    ) else {
        panic!("must be refused");
    };
    assert!(format!("{error}").contains("path segment"), "{error}");
}

#[test]
fn an_empty_app_password_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://smba.trafficmanager.net/emea/", "a:1"),
        "app-id",
        "   ",
        true,
    ) else {
        panic!("must be refused");
    };
    assert!(format!("{error}").contains("incomplete"), "{error}");
}

#[test]
fn a_foreign_record_is_refused() {
    let mut record = record("https://smba.trafficmanager.net/emea/", "a:1");
    record.format = "pi-desktop-messaging-something-else".into();
    let Err(error) = configured_adapter(&record, "app-id", "app-password", true) else {
        panic!("must be refused");
    };
    assert!(format!("{error}").contains(CODE), "{error}");
}

#[test]
fn an_access_token_is_read_from_the_grant_answer() {
    assert_eq!(
        access_token_in(r#"{"access_token":"abc","expires_in":3600}"#),
        Some("abc".to_string())
    );
    assert_eq!(access_token_in(r#"{"token_type":"Bearer"}"#), None);
}

#[test]
fn an_activity_id_is_read_from_the_send_answer() {
    assert_eq!(
        activity_id_in(r#"{"id":"1699999999999"}"#),
        Some("1699999999999".to_string())
    );
    assert_eq!(activity_id_in("not json"), None);
}

#[test]
fn a_refusal_names_the_status_and_the_reason() {
    let detail = refusal_detail(
        StatusCode::FORBIDDEN,
        r#"{"error":{"code":"Forbidden","message":"Bot is not a member"}}"#,
    );
    assert!(detail.contains("403"), "{detail}");
    assert!(detail.contains("Bot is not a member"), "{detail}");
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
fn registration_without_credentials_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    db.set_setting(
        "app",
        &json!({ SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": "https://smba.trafficmanager.net/emea/",
            "destination": "a:1",
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    let Err(error) = register(&mut registry, &db, &secrets) else {
        panic!("a configured channel without its credential is an error");
    };

    assert!(format!("{error}").contains("app id"), "{error}");
}
