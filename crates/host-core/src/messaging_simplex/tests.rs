use super::*;

use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::AdapterRegistry;
use crate::secrets::SecretStore;

#[test]
fn a_direct_chat_is_addressed_by_contact_id() {
    assert_eq!(target_of("7").expect("target"), "@7");
}

#[test]
fn a_group_is_addressed_by_group_id() {
    assert_eq!(target_of("group:3").expect("target"), "#3");
}

#[test]
fn a_display_name_is_refused_because_it_resolves_to_nothing() {
    let Err(error) = target_of("ann") else {
        panic!("a display name must be refused");
    };
    assert!(format!("{error}").contains("not a number"), "{error}");
}

#[test]
fn a_group_id_that_is_not_a_number_is_refused() {
    let Err(error) = target_of("group:abc") else {
        panic!("a non-numeric group id must be refused");
    };
    assert!(format!("{error}").contains("number"), "{error}");
}

#[test]
fn the_endpoint_must_be_a_websocket() {
    let Err(error) = check_endpoint("https://127.0.0.1:5225") else {
        panic!("an http endpoint must be refused");
    };
    assert!(format!("{error}").contains("not ws or wss"), "{error}");
    assert!(check_endpoint("ws://127.0.0.1:5225").is_ok());
    assert!(check_endpoint("wss://example.test:443").is_ok());
}

#[test]
fn a_sent_answer_is_a_delivery_with_its_id() {
    let outcome = classify_answer(
        r#"{"corrId":"pi-1","resp":{"type":"sentMessages","sentMessages":[{"id":99}]}}"#,
        "pi-1",
    );
    assert!(matches!(
        outcome,
        Some(SendResult::Delivered { remote_id: Some(id) }) if id == "99"
    ));
}

#[test]
fn a_refusal_from_the_daemon_is_terminal() {
    let outcome = classify_answer(
        r#"{"corrId":"pi-1","resp":{"type":"chatCmdError","chatError":{"errorType":{"type":"noContact"}}}}"#,
        "pi-1",
    );
    assert!(matches!(
        outcome,
        Some(SendResult::Failed {
            kind: FailureKind::Terminal,
            ..
        })
    ));
}

#[test]
fn an_answer_for_another_request_is_ignored() {
    assert!(classify_answer(
        r#"{"corrId":"other","resp":{"type":"sentMessages"}}"#,
        "pi-1"
    )
    .is_none());
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
fn registration_with_a_record_registers_the_channel() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    db.set_setting(
        "app",
        &json!({ SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": "ws://127.0.0.1:5225",
            "destination": "7",
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    register(&mut registry, &db, &secrets).expect("a complete record registers");
    assert!(registry.get(CHANNEL).is_some());
}

#[test]
fn a_record_with_a_bad_endpoint_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    db.set_setting(
        "app",
        &json!({ SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": "http://127.0.0.1:5225",
            "destination": "7",
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    let Err(error) = register(&mut registry, &db, &secrets) else {
        panic!("an http endpoint must be refused");
    };
    assert!(format!("{error}").contains("not ws or wss"), "{error}");
}
