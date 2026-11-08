use super::*;

use std::sync::Arc;

use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::{AdapterRegistry, OutboundMessage, SendResult};
use crate::messaging_outbound::envelope_text;
use crate::messaging_outbound::fixture::{fixture_answering, FixtureState};
use crate::secrets::SecretStore;

const USER_ID: &str = "zhangsan";
const CORP_ID: &str = "ww1234567890";
const CORP_SECRET: &str = "wecom-corp-secret";
const AGENT_ID: &str = "1000002";
const MINTED_TOKEN: &str = "wecom-access-token";

fn ok_body() -> String {
    json!({
        "errcode": 0,
        "errmsg": "ok",
        "access_token": MINTED_TOKEN,
        "expires_in": 7200,
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

fn adapter(endpoint: &str, destination: &str) -> WecomAdapter {
    configured_adapter(
        &record(endpoint, destination),
        CORP_ID,
        CORP_SECRET,
        AGENT_ID,
        true,
    )
    .expect("adapter")
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

async fn deliver(adapter: Arc<WecomAdapter>, message: OutboundMessage) -> SendResult {
    tokio::task::spawn_blocking(move || adapter.send(&message))
        .await
        .expect("send task")
}

fn body_of(request: &crate::messaging_outbound::fixture::SeenRequest) -> serde_json::Value {
    serde_json::from_slice(&request.body).expect("request body is JSON")
}

#[tokio::test]
async fn one_attempt_mints_a_token_then_posts_the_summary() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: ok_body(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, USER_ID));

    let result = deliver(adapter, summary()).await;

    assert!(matches!(result, SendResult::Delivered { .. }), "{result:?}");
    let requests = fixture.requests();
    assert_eq!(requests.len(), 2, "one token exchange and one send");
    assert_eq!(requests[0].path, TOKEN_PATH);
    assert_eq!(requests[0].method.to_uppercase(), "GET");
    assert_eq!(requests[1].path, SEND_PATH);
}

#[tokio::test]
async fn the_send_names_the_user_the_agent_and_the_text() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: ok_body(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, USER_ID));

    let _ = deliver(adapter, summary()).await;

    let send = fixture.requests().pop().expect("a send");
    let body = body_of(&send);
    assert_eq!(body["touser"], USER_ID);
    assert_eq!(body["msgtype"], "text");
    assert_eq!(body["agentid"], 1_000_002);
    assert_eq!(body["text"]["content"], envelope_text(&summary()));
}

#[tokio::test]
async fn a_refused_credential_is_terminal_and_never_posts() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "errcode": 40001, "errmsg": "invalid credential" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, USER_ID));

    let result = deliver(adapter, summary()).await;

    match result {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Terminal);
            assert!(detail.contains("40001"), "{detail}");
            assert!(
                !detail.contains(CORP_SECRET),
                "the secret never reaches a detail"
            );
        }
        other => panic!("expected a terminal refusal, got {other:?}"),
    }
    assert_eq!(fixture.requests().len(), 1, "a refused app never posts");
}

#[tokio::test]
async fn a_throttled_exchange_is_retryable() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "errcode": 45009, "errmsg": "api freq out of limit" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, USER_ID));

    match deliver(adapter, summary()).await {
        SendResult::Failed { kind, .. } => assert_eq!(kind, FailureKind::Retryable),
        other => panic!("expected a retryable refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn an_errcode_in_a_200_response_is_still_a_refusal() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "errcode": 81013, "errmsg": "user not allowed" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, USER_ID));

    assert!(
        matches!(deliver(adapter, summary()).await, SendResult::Failed { .. }),
        "a non-zero errcode is never a delivery"
    );
}

#[test]
fn an_agent_id_that_is_not_a_number_is_refused() {
    let error = configured_adapter(
        &record("https://qyapi.weixin.qq.com", USER_ID),
        CORP_ID,
        CORP_SECRET,
        "not-a-number",
        true,
    )
    .err()
    .expect("a non-numeric agent id is refused");
    assert!(format!("{error}").contains("agent id"), "{error}");
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
