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
fn the_token_url_carries_the_credential_and_the_send_url_does_not() {
    let adapter = configured_adapter(
        &record("https://api.weixin.qq.com", "oUser123"),
        "wxappid",
        "appsecret",
        true,
    )
    .expect("adapter");
    let token = adapter.token_url.as_str();
    assert!(token.contains("grant_type=client_credential"), "{token}");
    assert!(token.contains("appid=wxappid"), "{token}");
    assert!(token.contains("secret=appsecret"), "{token}");
    assert_eq!(
        adapter.send_url.as_str(),
        "https://api.weixin.qq.com/cgi-bin/message/custom/send"
    );
}

#[test]
fn the_send_url_carries_the_access_token_in_the_query() {
    let adapter = configured_adapter(
        &record("https://api.weixin.qq.com", "oUser123"),
        "wxappid",
        "appsecret",
        true,
    )
    .expect("adapter");
    let url = adapter.send_url_with_token("TOKEN").expect("url");
    assert!(url
        .as_str()
        .ends_with("/cgi-bin/message/custom/send?access_token=TOKEN"));
}

#[test]
fn an_empty_open_id_is_refused() {
    let Err(error) =
        configured_adapter(&record("https://api.weixin.qq.com", "   "), "a", "b", true)
    else {
        panic!("an empty open id must be refused");
    };
    assert!(format!("{error}").contains("open id"), "{error}");
}

#[test]
fn an_incomplete_registration_is_refused() {
    let Err(error) = configured_adapter(
        &record("https://api.weixin.qq.com", "oUser123"),
        "a",
        " ",
        true,
    ) else {
        panic!("an incomplete registration must be refused");
    };
    assert!(format!("{error}").contains("incomplete"), "{error}");
}

#[test]
fn the_window_and_the_credential_are_terminal_but_limits_are_not() {
    assert!(matches!(weixin_failure_kind(45015), FailureKind::Terminal));
    assert!(matches!(weixin_failure_kind(40001), FailureKind::Terminal));
    assert!(matches!(weixin_failure_kind(45009), FailureKind::Retryable));
    assert!(matches!(weixin_failure_kind(-1), FailureKind::Retryable));
}

#[test]
fn a_refusal_says_what_the_number_means() {
    assert!(weixin_detail(45015).contains("48-hour"));
    assert!(weixin_detail(40001).contains("credential"));
}

#[test]
fn the_errcode_is_read_from_the_answer() {
    assert_eq!(errcode_in(r#"{"errcode":0,"errmsg":"ok"}"#), Some(0));
    assert_eq!(
        errcode_in(r#"{"errcode":45015,"errmsg":"expired"}"#),
        Some(45015)
    );
    assert_eq!(errcode_in("not json"), None);
}

#[test]
fn an_access_token_is_read_from_the_token_answer() {
    assert_eq!(
        access_token_in(r#"{"access_token":"abc","expires_in":7200}"#),
        Some("abc".to_string())
    );
    assert_eq!(
        access_token_in(r#"{"errcode":40013,"errmsg":"invalid appid"}"#),
        None
    );
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
fn registration_without_an_app_secret_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    db.set_setting(
        "app",
        &json!({ SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": "https://api.weixin.qq.com",
            "destination": "oUser123",
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    let Err(error) = register(&mut registry, &db, &secrets) else {
        panic!("a configured channel without its credential must be an error");
    };

    assert!(format!("{error}").contains("app id"), "{error}");
}
