use super::*;

use std::sync::Arc;

use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::{AdapterRegistry, FailureKind, OutboundMessage, SendResult};
use crate::messaging_outbound::envelope_text;
use crate::messaging_outbound::fixture::{fixture_answering, FixtureState};
use crate::secrets::SecretStore;

const TO_USER: &str = "U4af4980629";
const TOKEN: &str = "line-channel-access-token";

fn record(endpoint: &str, destination: &str) -> StoredConfig {
    serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": endpoint,
        "destination": destination,
    }))
    .expect("record")
}

fn adapter(endpoint: &str, destination: &str) -> HttpChannelAdapter {
    configured_adapter(&record(endpoint, destination), TOKEN, true).expect("adapter")
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

async fn deliver(adapter: Arc<HttpChannelAdapter>, message: OutboundMessage) -> SendResult {
    tokio::task::spawn_blocking(move || adapter.send(&message))
        .await
        .expect("send task")
}

fn body_of(request: &crate::messaging_outbound::fixture::SeenRequest) -> serde_json::Value {
    serde_json::from_slice(&request.body).expect("request body is JSON")
}

#[tokio::test]
async fn one_attempt_posts_the_summary_as_a_single_message() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: "{}".into(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, TO_USER));

    let result = deliver(adapter, summary()).await;

    assert!(matches!(result, SendResult::Delivered { .. }), "{result:?}");
    let requests = fixture.requests();
    assert_eq!(requests.len(), 1, "one request per attempt");
    assert_eq!(requests[0].path, SEND_PATH);
    let body = body_of(&requests[0]);
    assert_eq!(body["to"], TO_USER);
    assert_eq!(body["messages"][0]["type"], "text");
    assert_eq!(body["messages"][0]["text"], envelope_text(&summary()));
}

#[tokio::test]
async fn the_send_carries_the_bearer_token_and_no_credential_in_the_url() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: "{}".into(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, TO_USER));

    let _ = deliver(adapter, summary()).await;

    let send = fixture.requests().pop().expect("a send");
    let authorization = send
        .headers
        .iter()
        .find(|(name, _)| name == "authorization")
        .map(|(_, value)| value.clone());
    assert_eq!(
        authorization.as_deref(),
        Some(format!("Bearer {TOKEN}").as_str())
    );
    assert!(
        !send.path.contains(TOKEN),
        "a credential never travels in the path"
    );
}

#[tokio::test]
async fn a_refused_credential_is_terminal() {
    let fixture = fixture_answering(FixtureState {
        status: 401,
        body: json!({ "message": "invalid token" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, TO_USER));

    match deliver(adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Terminal);
            assert!(!detail.contains(TOKEN), "the token never reaches a detail");
        }
        other => panic!("expected a terminal refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn a_throttled_send_is_retryable() {
    let fixture = fixture_answering(FixtureState {
        status: 429,
        body: "{}".into(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, TO_USER));

    match deliver(adapter, summary()).await {
        SendResult::Failed { kind, .. } => assert_eq!(kind, FailureKind::Retryable),
        other => panic!("expected a retryable refusal, got {other:?}"),
    }
}

#[test]
fn an_empty_destination_is_refused() {
    let error = configured_adapter(&record("https://api.line.me", "   "), TOKEN, true)
        .err()
        .expect("an empty destination is refused");
    assert!(format!("{error}").contains("destination"), "{error}");
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
