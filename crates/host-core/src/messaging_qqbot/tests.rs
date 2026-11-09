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
fn the_send_url_names_the_user() {
    let adapter = configured_adapter(
        &record("https://api.sgroup.qq.com", "A1B2C3D4"),
        "app-id",
        "app-secret",
        true,
    )
    .expect("adapter");
    assert_eq!(
        adapter.send_url.as_str(),
        "https://api.sgroup.qq.com/v2/users/A1B2C3D4/messages"
    );
    assert_eq!(
        adapter.token_url.as_str(),
        "https://bots.qq.com/app/getAppAccessToken"
    );
}

#[test]
fn an_open_id_that_is_not_one_path_segment_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://api.sgroup.qq.com", "A1/../../admin"),
        "app-id",
        "app-secret",
        true,
    ) else {
        panic!("a destination with a slash must be refused");
    };
    assert!(format!("{error}").contains("path segment"), "{error}");
}

#[test]
fn an_incomplete_registration_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://api.sgroup.qq.com", "A1"),
        "app-id",
        "  ",
        true,
    ) else {
        panic!("an incomplete registration must be refused");
    };
    assert!(format!("{error}").contains("incomplete"), "{error}");
}

#[test]
fn a_foreign_record_is_refused() {
    let mut record = record("https://api.sgroup.qq.com", "A1");
    record.format = "pi-desktop-messaging-something-else".into();
    let Err(error) = configured_adapter(&record, "app-id", "app-secret", true) else {
        panic!("a foreign record must be refused");
    };
    assert!(format!("{error}").contains(CODE), "{error}");
}

#[test]
fn the_access_token_is_read_from_the_answer() {
    assert_eq!(
        access_token_in(r#"{"access_token":"abc","expires_in":7200}"#),
        Some("abc".to_string())
    );
    assert_eq!(
        access_token_in(r#"{"code":100016,"message":"invalid appid"}"#),
        None
    );
    assert_eq!(
        error_code_in(r#"{"code":100016,"message":"invalid appid"}"#),
        Some(100016)
    );
}

#[test]
fn the_message_id_is_read_from_the_answer() {
    assert_eq!(
        message_id_in(r#"{"id":"msg-1"}"#),
        Some("msg-1".to_string())
    );
    assert_eq!(message_id_in("not json"), None);
}

#[test]
fn a_refusal_names_the_status_and_qq_s_message() {
    let detail = refusal_detail(
        StatusCode::FORBIDDEN,
        r#"{"code":11298,"message":"active message quota exceeded"}"#,
    );
    assert!(detail.contains("403"), "{detail}");
    assert!(detail.contains("quota"), "{detail}");
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
            "endpoint": "https://api.sgroup.qq.com",
            "destination": "A1",
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    let Err(error) = register(&mut registry, &db, &secrets) else {
        panic!("a configured channel without its credential must be an error");
    };

    assert!(format!("{error}").contains("app id"), "{error}");
}
