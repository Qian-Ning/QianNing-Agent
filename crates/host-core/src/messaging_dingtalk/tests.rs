use super::*;

use std::sync::Arc;

use serde_json::json;

use crate::db::Database;
use crate::delivery_ledger::{self, DeliveryState};
use crate::messaging_adapter::{
    self, AdapterRegistry, AttemptOutcome, OutboundMessage, SendResult,
};
use crate::messaging_outbound::envelope_text;
use crate::messaging_outbound::fixture::{fixture_answering, FixtureState};
use crate::secrets::SecretStore;

/// The channel id the tests deliver to.
const CHANNEL_ID: &str = "7d2m9pqr4st6uv8w0xyz1abcde";
/// The app credentials the tests store.
const APP_KEY: &str = "ding-app-key";
const APP_SECRET: &str = "ding-app-secret";
/// The token the fake platform mints.
const MINTED_TOKEN: &str = "minted-access-token";

/// A stored record in the shape the `messagingDingtalk` settings section carries.
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

/// A connected adapter aimed at `endpoint`, built through the same record shape
/// and the same construction `register` uses. The plaintext hop is acknowledged
/// here exactly as the sibling channels' tests acknowledge theirs.
fn adapter(endpoint: &str, destination: &str, timeout: Option<u64>) -> DingtalkAdapter {
    configured_adapter(
        &record(endpoint, destination, timeout),
        APP_KEY,
        APP_SECRET,
        true,
    )
    .expect("adapter")
}

/// The redacted summary the relay hands the ledger for one completed turn.
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
            "epoch": "epoch-1",
            "sequence": 4,
            "revision": 12,
            "status": "completed",
            "agentName": "claude",
            "occurredAt": "2026-10-17T00:00:00Z",
        }),
        redelivery: false,
    }
}

/// A token answer, in the shape the platform documents.
fn token_answer(token: &str) -> String {
    json!({ "accessToken": token, "expireIn": 7200 }).to_string()
}

/// Drive one attempt off the runtime's worker thread, so the fixture sharing this
/// current-thread runtime can still answer it.
async fn deliver(adapter: Arc<DingtalkAdapter>, message: OutboundMessage) -> SendResult {
    tokio::task::spawn_blocking(move || adapter.send(&message))
        .await
        .expect("send task")
}

fn host_settings() -> (tempfile::TempDir, Database, SecretStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    (dir, db, secrets)
}

/// The delivery body the fake platform received, as JSON.
fn body_of(request: &crate::messaging_outbound::fixture::SeenRequest) -> serde_json::Value {
    serde_json::from_slice(&request.body).expect("request body is JSON")
}

/// The value of one header the fake platform saw, by lowercased name.
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
async fn one_attempt_mints_a_ticket_then_posts_the_summary_through_it() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: token_answer(MINTED_TOKEN),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHANNEL_ID, None));

    let result = deliver(adapter, summary()).await;

    assert!(matches!(result, SendResult::Delivered { .. }), "{result:?}");
    let requests = fixture.requests();
    assert_eq!(requests.len(), 2, "one exchange and one send");

    let exchange = &requests[0];
    assert_eq!(exchange.method, "POST");
    assert_eq!(exchange.path, TOKEN_PATH);
    let credentials = body_of(exchange);
    assert_eq!(credentials["appKey"], APP_KEY);
    assert_eq!(credentials["appSecret"], APP_SECRET);

    let send = &requests[1];
    assert_eq!(send.method, "POST");
    assert_eq!(send.path, SEND_PATH);
    assert_eq!(
        header_of(send, TOKEN_HEADER).as_deref(),
        Some(MINTED_TOKEN),
        "the send carries the token the exchange just minted"
    );
    assert_eq!(
        header_of(send, "authorization"),
        None,
        "no bearer header: this platform reads the token from its own header"
    );
}

#[tokio::test]
async fn the_send_names_the_conversation_the_robot_and_the_template() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: token_answer(MINTED_TOKEN),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHANNEL_ID, None));

    let _ = deliver(adapter, summary()).await;

    let send = fixture.requests().pop().expect("a send");
    let body = body_of(&send);
    assert_eq!(body["openConversationId"], CHANNEL_ID);
    assert_eq!(body["msgKey"], MSG_KEY);
    assert_eq!(
        body["robotCode"], APP_KEY,
        "the robot code is the app's own client id"
    );
    // The platform reads the text out of a template parameter that is itself a
    // JSON string, so the summary is nested one level deep.
    let param: serde_json::Value =
        serde_json::from_str(body["msgParam"].as_str().expect("msgParam is a string"))
            .expect("msgParam is JSON");
    let expected = envelope_text(&summary());
    assert_eq!(param["content"], expected);
}

#[tokio::test]
async fn a_refused_credential_is_terminal_and_never_reaches_the_send() {
    let fixture = fixture_answering(FixtureState {
        status: 400,
        body: json!({
            "code": "invalidClientIdOrSecret",
            "message": "the app is not known",
        })
        .to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHANNEL_ID, None));

    let result = deliver(adapter, summary()).await;

    match result {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Terminal, "a bad app never recovers");
            assert!(
                detail.contains("invalidClientIdOrSecret"),
                "the platform's own code is named: {detail}"
            );
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    assert_eq!(
        fixture.requests().len(),
        1,
        "a refused ticket stops the attempt before the send"
    );
}

#[tokio::test]
async fn a_throttled_exchange_is_retryable() {
    let fixture = fixture_answering(FixtureState {
        status: 429,
        body: json!({ "code": "Throttling", "message": "slow down" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHANNEL_ID, None));

    let result = deliver(adapter, summary()).await;

    match result {
        SendResult::Failed { kind, .. } => assert_eq!(kind, FailureKind::Retryable),
        other => panic!("expected a retryable failure, got {other:?}"),
    }
}

#[tokio::test]
async fn a_token_answer_without_a_token_is_retryable() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "expireIn": 7200 }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHANNEL_ID, None));

    let result = deliver(adapter, summary()).await;

    match result {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Retryable);
            assert!(detail.contains("without an access token"), "{detail}");
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    assert_eq!(fixture.requests().len(), 1, "no send without a ticket");
}

#[tokio::test]
async fn a_failed_send_names_the_platform_code() {
    let fixture = fixture_answering(FixtureState {
        status: 400,
        body: json!({
            "code": "invalidParameter.openConversationId",
            "message": "no such conversation",
        })
        .to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHANNEL_ID, None));

    let result = deliver(adapter, summary()).await;

    match result {
        SendResult::Failed { detail, .. } => {
            assert!(
                detail.contains("invalidParameter.openConversationId"),
                "the platform's own code is named: {detail}"
            );
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[tokio::test]
async fn a_send_through_a_refused_token_is_not_a_credential_refusal() {
    // The exchange succeeds and the send is refused: the app is fine, so this is
    // the send's own failure and keeps the shared status rule.
    let fixture = fixture_answering(FixtureState {
        status: 403,
        body: json!({ "code": "Forbidden.AccessDenied", "message": "no" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, CHANNEL_ID, None));

    let result = deliver(adapter, summary()).await;

    // The fixture answers 403 to both steps, so the exchange is what fails here;
    // either way the answer must be a failure and never a delivery.
    assert!(matches!(result, SendResult::Failed { .. }), "{result:?}");
}

#[tokio::test]
async fn a_record_with_the_wrong_format_is_refused_at_registration() {
    let mut wrong = record("https://api.dingtalk.com", CHANNEL_ID, None);
    wrong.format = "pi-desktop-messaging-elsewhere".into();
    let Err(error) = configured_adapter(&wrong, APP_KEY, APP_SECRET, false) else {
        panic!("a foreign record is refused");
    };
    assert!(format!("{error}").contains("unsupported dingtalk settings record"));
}

#[tokio::test]
async fn an_empty_destination_is_refused_at_registration() {
    let empty = record("https://api.dingtalk.com", "   ", None);
    let Err(error) = configured_adapter(&empty, APP_KEY, APP_SECRET, false) else {
        panic!("an empty conversation is refused");
    };
    assert!(format!("{error}").contains("destination conversation is empty"));
}

#[tokio::test]
async fn a_plaintext_endpoint_is_refused_unless_the_policy_allows_it() {
    let plain = record("http://api.dingtalk.com", CHANNEL_ID, None);
    let Err(error) = configured_adapter(&plain, APP_KEY, APP_SECRET, false) else {
        panic!("a plaintext endpoint is refused");
    };
    assert!(format!("{error}").contains(CODE));
}

#[tokio::test]
async fn register_leaves_a_host_without_a_record_alone() {
    let (_dir, db, secrets) = host_settings();
    let mut registry = AdapterRegistry::new();

    register(&mut registry, &db, &secrets).expect("no record is not an error");

    assert!(registry.names().is_empty(), "nothing was registered");
}

#[tokio::test]
async fn register_refuses_a_configured_channel_without_credentials() {
    let (_dir, db, secrets) = host_settings();
    db.set_setting(
        "app",
        &json!({
            SETTINGS_SECTION: {
                "format": FORMAT,
                "version": FORMAT_VERSION,
                "endpoint": "https://api.dingtalk.com",
                "destination": CHANNEL_ID,
            }
        }),
    )
    .expect("settings");
    let mut registry = AdapterRegistry::new();

    let error = register(&mut registry, &db, &secrets)
        .expect_err("a configured channel without credentials is an error");

    assert!(format!("{error}").contains("no app key is configured"));
    assert!(registry.names().is_empty());
}

#[tokio::test]
async fn register_installs_the_channel_under_its_ledger_name() {
    let (_dir, db, secrets) = host_settings();
    db.set_setting(
        "app",
        &json!({
            SETTINGS_SECTION: {
                "format": FORMAT,
                "version": FORMAT_VERSION,
                "endpoint": "https://api.dingtalk.com",
                "destination": CHANNEL_ID,
            }
        }),
    )
    .expect("settings");
    secrets
        .set(CLIENT_ID_SECRET_REF, APP_KEY)
        .expect("app key stored");
    secrets
        .set(CLIENT_SECRET_SECRET_REF, APP_SECRET)
        .expect("app secret stored");
    let mut registry = AdapterRegistry::new();

    register(&mut registry, &db, &secrets).expect("registration");

    assert_eq!(registry.names(), vec![CHANNEL]);
}

#[tokio::test]
async fn the_ledger_delivers_through_the_registered_channel() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: token_answer(MINTED_TOKEN),
        ..FixtureState::default()
    })
    .await;
    let (_dir, db, _secrets) = host_settings();
    let mut registry = AdapterRegistry::new();
    registry
        .register(
            CHANNEL,
            Box::new(adapter(&fixture.endpoint, CHANNEL_ID, None)),
        )
        .expect("registration");
    let delivery = messaging_adapter::enqueue_for(&db, &registry, CHANNEL, summary().payload)
        .expect("enqueue");
    assert_eq!(
        delivery_ledger::get(&db, &delivery.id)
            .expect("read")
            .expect("persisted")
            .state,
        DeliveryState::Pending,
        "a hand-off starts the delivery pending"
    );

    let outcome = tokio::task::spawn_blocking(move || {
        messaging_adapter::attempt_one(&db, &registry, "worker-1")
    })
    .await
    .expect("attempt task")
    .expect("attempt");

    assert_eq!(
        outcome,
        AttemptOutcome::Delivered {
            id: delivery.id.clone()
        },
        "the attempt cycle delivered the summary through the registered channel"
    );
    assert_eq!(fixture.requests().len(), 2, "one exchange and one send");
}
