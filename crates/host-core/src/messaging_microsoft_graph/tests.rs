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
fn the_send_url_splits_the_two_ids_out_of_the_destination() {
    let adapter = configured_adapter(
        &record(
            "https://graph.microsoft.com/v1.0",
            "team-1/19:abc@thread.tacv2",
        ),
        "tenant-1",
        "client-1",
        "secret-1",
        true,
    )
    .expect("adapter");
    assert_eq!(
        adapter.send_url.as_str(),
        "https://graph.microsoft.com/v1.0/teams/team-1/channels/19:abc@thread.tacv2/messages"
    );
    assert!(adapter
        .token_url
        .as_str()
        .starts_with("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token"));
}

#[test]
fn a_destination_without_a_channel_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://graph.microsoft.com/v1.0", "team-1"),
        "t",
        "c",
        "s",
        true,
    ) else {
        panic!("a destination without a channel must be refused");
    };
    assert!(format!("{error}").contains("channel id"), "{error}");
}

#[test]
fn an_incomplete_registration_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://graph.microsoft.com/v1.0", "team-1/channel-1"),
        "  ",
        "c",
        "s",
        true,
    ) else {
        panic!("an incomplete registration must be refused");
    };
    assert!(format!("{error}").contains("incomplete"), "{error}");
}

#[test]
fn a_foreign_record_is_refused() {
    let mut record = record("https://graph.microsoft.com/v1.0", "team-1/channel-1");
    record.format = "pi-desktop-messaging-something-else".into();
    let Err(error) = configured_adapter(&record, "t", "c", "s", true) else {
        panic!("a foreign record must be refused");
    };
    assert!(format!("{error}").contains(CODE), "{error}");
}

#[test]
fn the_message_id_is_read_from_the_answer() {
    assert_eq!(
        message_id_in(r#"{"id":"1700000000000"}"#),
        Some("1700000000000".to_string())
    );
    assert_eq!(message_id_in("not json"), None);
}

#[test]
fn a_refusal_names_graph_s_code_and_message() {
    let detail = refusal_detail(
        StatusCode::FORBIDDEN,
        r#"{"error":{"code":"Forbidden","message":"Insufficient privileges"}}"#,
    );
    assert!(detail.contains("403"), "{detail}");
    assert!(detail.contains("Forbidden"), "{detail}");
    assert!(detail.contains("Insufficient privileges"), "{detail}");
}

#[test]
fn an_access_token_is_read_from_the_grant_answer() {
    assert_eq!(
        access_token_in(r#"{"token_type":"Bearer","access_token":"abc"}"#),
        Some("abc".to_string())
    );
    assert_eq!(access_token_in(r#"{"error":"invalid_client"}"#), None);
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
fn registration_without_a_tenant_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    db.set_setting(
        "app",
        &json!({ SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": "https://graph.microsoft.com/v1.0",
            "destination": "team-1/channel-1",
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    let Err(error) = register(&mut registry, &db, &secrets) else {
        panic!("a configured channel without its credential must be an error");
    };

    assert!(format!("{error}").contains("tenant"), "{error}");
}
