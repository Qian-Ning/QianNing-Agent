use super::*;

use std::sync::Arc;

use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::{
    self, AdapterRegistry, AttemptOutcome, OutboundMessage, SendResult,
};
use crate::messaging_outbound::envelope_text;
use crate::messaging_outbound::fixture::{fixture_answering, FixtureState};
use crate::secrets::SecretStore;

/// The chat id the tests deliver to.
const CHAT_ID: &str = "oc_7d2m9pqr4st6uv8w0xyz";
/// The app credentials the tests store.
const APP_ID: &str = "cli_feishu_app";
const APP_SECRET: &str = "feishu-app-secret";
/// The token the fake platform mints.
const MINTED_TOKEN: &str = "t-minted-tenant-token";
/// The message id the fake platform returns.
const MESSAGE_ID: &str = "om_delivered";

/// A body both the token exchange and the send accept.
fn ok_body() -> String {
    json!({
        "code": 0,
        "msg": "ok",
        "tenant_access_token": MINTED_TOKEN,
        "expire": 7200,
        "data": { "message_id": MESSAGE_ID },
    })
    .to_string()
}

/// A stored record in the shape the `messagingFeishu` settings section carries.
fn record(endpoint: &str, destination: &str, timeout: Option<u64>) -> StoredConfig {
    serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": endpoint,
        "destination": destination,
        "requestTimeoutMs": timeout,
    }))
    .expect("record")
}

fn adapter(endpoint: &str, destination: &str, timeout: Option<u64>) -> FeishuAdapter {
    configured_adapter(
        &record(endpoint, destination, timeout),
        APP_ID,
        APP_SECRET,
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
            "sessionTitle": "A session",
            "turnId": "turn-9",
            "status": "completed",
            "agentName": "claude",
            "occurredAt": "2026-10-17T00:00:00Z",
        }),
        redelivery: false,
    }
}

async fn deliver(adapter: Arc<FeishuAdapter>, message: OutboundMessage) -> SendResult {
    tokio::task::spawn_blocking(move || adapter.send(&message))
        .await
        .expect("send task")
}

fn body_of(request: &crate::messaging_outbound::fixture::SeenRequest) -> serde_json::Value {
    serde_json::from_slice(&request.body).expect("request body is JSON")
}

fn header_of(
    request: &crate::messaging_outbound::fixture::SeenRequest,
    name: &str,
) -> Option<String> {
    request
        .headers
        .iter()
        .find(|(header, _)| header == name)
        .map(|(_, value)| value.clone())
}

#[tokio::test]
async fn one_attempt_mints_a_token_then_posts_the_summary_through_it() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: ok_body(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHAT_ID, None));

    let result = deliver(adapter, summary()).await;

    assert!(matches!(result, SendResult::Delivered { .. }), "{result:?}");
    let requests = fixture.requests();
    assert_eq!(requests.len(), 2, "one exchange and one send");

    let exchange = &requests[0];
    assert_eq!(exchange.method, "POST");
    assert_eq!(exchange.path, TOKEN_PATH);
    let credentials = body_of(exchange);
    assert_eq!(credentials["app_id"], APP_ID);
    assert_eq!(credentials["app_secret"], APP_SECRET);

    let send = &requests[1];
    assert_eq!(send.method, "POST");
    // The fixture records the path without its query string, which is where
    // `receive_id_type=chat_id` lives.
    assert_eq!(send.path, "/open-apis/im/v1/messages");
    assert_eq!(
        header_of(send, "authorization").as_deref(),
        Some(format!("Bearer {MINTED_TOKEN}").as_str()),
        "the send carries the token the exchange just minted"
    );
}

#[tokio::test]
async fn the_send_names_the_chat_the_type_and_the_nested_content() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: ok_body(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHAT_ID, None));

    let _ = deliver(adapter, summary()).await;

    let send = fixture.requests().pop().expect("a send");
    let body = body_of(&send);
    assert_eq!(body["receive_id"], CHAT_ID);
    assert_eq!(body["msg_type"], "text");
    // Feishu takes `content` as a JSON string, not as an object.
    let content: serde_json::Value =
        serde_json::from_str(body["content"].as_str().expect("content is a string"))
            .expect("content is JSON");
    assert_eq!(content["text"], envelope_text(&summary()));
}

#[tokio::test]
async fn the_delivered_message_id_is_kept() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: ok_body(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHAT_ID, None));

    let result = deliver(adapter, summary()).await;

    match result {
        SendResult::Delivered { remote_id } => {
            assert_eq!(remote_id.as_deref(), Some(MESSAGE_ID));
        }
        other => panic!("expected a delivery, got {other:?}"),
    }
}

#[tokio::test]
async fn a_refused_credential_is_terminal_and_never_reaches_the_send() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "code": 99991661, "msg": "invalid app_id or app_secret" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHAT_ID, None));

    let result = deliver(adapter, summary()).await;

    match result {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Terminal);
            assert!(detail.contains("99991661"), "{detail}");
            assert!(
                !detail.contains(APP_SECRET),
                "the secret never reaches a detail"
            );
        }
        other => panic!("expected a terminal refusal, got {other:?}"),
    }
    assert_eq!(fixture.requests().len(), 1, "a refused app never posts");
}

#[tokio::test]
async fn a_throttled_token_exchange_is_retryable() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "code": 99991400, "msg": "too many requests" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHAT_ID, None));

    let result = deliver(adapter, summary()).await;

    match result {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Retryable);
            assert!(detail.contains("99991400"), "{detail}");
        }
        other => panic!("expected a retryable refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn a_refusal_that_arrives_as_http_200_is_still_a_refusal() {
    // Feishu answers a rejected send with 200 and a non-zero code. A channel
    // that only read the status would record a delivery that never happened.
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "code": 230002, "msg": "bot not in chat" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHAT_ID, None));

    let result = deliver(adapter, summary()).await;

    assert!(
        matches!(result, SendResult::Failed { .. }),
        "a non-zero code is never a delivery: {result:?}"
    );
}

#[tokio::test]
async fn a_record_from_a_different_build_is_refused() {
    let mut record = record("https://open.feishu.cn", CHAT_ID, None);
    record.format = "pi-desktop-messaging-something-else".into();
    let error = configured_adapter(&record, APP_ID, APP_SECRET, true)
        .err()
        .expect("a foreign record is refused");
    assert!(format!("{error}").contains(CODE), "{error}");
}

#[tokio::test]
async fn an_empty_destination_is_refused_before_any_request() {
    let error = configured_adapter(
        &record("https://open.feishu.cn", "   ", None),
        APP_ID,
        APP_SECRET,
        true,
    )
    .err()
    .expect("an empty destination is refused");
    assert!(format!("{error}").contains("destination"), "{error}");
}

#[tokio::test]
async fn plaintext_endpoints_are_refused_unless_relaxed() {
    let error = configured_adapter(
        &record("http://open.feishu.cn", CHAT_ID, None),
        APP_ID,
        APP_SECRET,
        false,
    )
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

#[test]
fn registration_with_a_record_but_no_secret_is_an_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    db.set_setting(
        "app",
        &json!({ SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": "https://open.feishu.cn",
            "destination": CHAT_ID,
        }}),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::default();

    let error = register(&mut registry, &db, &secrets)
        .err()
        .expect("a configured channel without its credential is an error");

    assert!(format!("{error}").contains("app id"), "{error}");
}
