use super::*;

use std::sync::Arc;

use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::{AdapterRegistry, FailureKind, OutboundMessage, SendResult};
use crate::messaging_outbound::envelope_text;
use crate::messaging_outbound::fixture::{fixture_answering, FixtureState};
use crate::secrets::SecretStore;

const WEBHOOK_KEY: &str = "693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa";

fn record(endpoint: &str) -> StoredConfig {
    serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": endpoint,
    }))
    .expect("record")
}

fn adapter(endpoint: &str) -> WecomGroupAdapter {
    configured_adapter(&record(endpoint), WEBHOOK_KEY, true).expect("adapter")
}

fn summary() -> OutboundMessage {
    OutboundMessage {
        id: "delivery-1".into(),
        channel: CHANNEL.into(),
        payload: json!({
            "eventId": "event-7",
            "kind": "turn.completed",
            "scope": "host",
            "sessionId": "session-1",
            "turnId": "turn-9",
            "status": "completed",
            "agentName": "claude",
            "occurredAt": "2026-10-17T00:00:00Z",
        }),
        redelivery: false,
    }
}

async fn deliver(adapter: Arc<WecomGroupAdapter>, message: OutboundMessage) -> SendResult {
    tokio::task::spawn_blocking(move || adapter.send(&message))
        .await
        .expect("send task")
}

fn body_of(request: &crate::messaging_outbound::fixture::SeenRequest) -> serde_json::Value {
    serde_json::from_slice(&request.body).expect("request body is JSON")
}

#[tokio::test]
async fn one_attempt_posts_the_summary_to_the_robot() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "errcode": 0, "errmsg": "ok" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint));

    let result = deliver(adapter, summary()).await;

    assert!(matches!(result, SendResult::Delivered { .. }), "{result:?}");
    let requests = fixture.requests();
    assert_eq!(requests.len(), 1, "one request per delivery");
    assert_eq!(requests[0].path, SEND_PATH);
    let body = body_of(&requests[0]);
    assert_eq!(body["msgtype"], "text");
    assert_eq!(body["text"]["content"], envelope_text(&summary()));
}

#[tokio::test]
async fn a_bad_key_is_terminal_and_names_its_code() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "errcode": 93000, "errmsg": "invalid webhook url" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint));

    match deliver(adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Terminal);
            assert!(detail.contains("93000"), "{detail}");
            assert!(
                !detail.contains(WEBHOOK_KEY),
                "the key never reaches a detail"
            );
        }
        other => panic!("expected a terminal refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn a_quota_refusal_is_retryable() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "errcode": 45009, "errmsg": "api freq out of limit" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint));

    match deliver(adapter, summary()).await {
        SendResult::Failed { kind, .. } => assert_eq!(kind, FailureKind::Retryable),
        other => panic!("expected a retryable refusal, got {other:?}"),
    }
}

#[test]
fn an_empty_key_is_refused_before_any_request() {
    let error = configured_adapter(&record("https://qyapi.weixin.qq.com"), "   ", true)
        .err()
        .expect("an empty key is refused");
    assert!(format!("{error}").contains("key"), "{error}");
}

#[test]
fn plaintext_endpoints_are_refused_unless_relaxed() {
    let error = configured_adapter(&record("http://qyapi.weixin.qq.com"), WEBHOOK_KEY, false)
        .err()
        .expect("http is refused");
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
