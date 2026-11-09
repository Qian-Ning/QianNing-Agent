use super::*;

use std::sync::Arc;

use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::{AdapterRegistry, FailureKind, OutboundMessage, SendResult};
use crate::messaging_outbound::envelope_text;
use crate::messaging_outbound::fixture::{fixture_answering, FixtureState};
use crate::secrets::SecretStore;

const ACCOUNT_SID: &str = "AC1234567890abcdef";
const AUTH_TOKEN: &str = "twilio-auth-token";
const FROM_NUMBER: &str = "+15559876543";
const TO_NUMBER: &str = "+15551234567";

fn record(endpoint: &str, destination: &str) -> StoredConfig {
    serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": endpoint,
        "destination": destination,
    }))
    .expect("record")
}

fn adapter(endpoint: &str, destination: &str) -> SmsAdapter {
    configured_adapter(
        &record(endpoint, destination),
        ACCOUNT_SID,
        AUTH_TOKEN,
        FROM_NUMBER,
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

async fn deliver(adapter: Arc<SmsAdapter>, message: OutboundMessage) -> SendResult {
    tokio::task::spawn_blocking(move || adapter.send(&message))
        .await
        .expect("send task")
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
async fn one_attempt_posts_the_summary_as_a_form() {
    let fixture = fixture_answering(FixtureState {
        status: 201,
        body: json!({ "sid": "SM123", "status": "queued" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, TO_NUMBER));

    let result = deliver(adapter, summary()).await;

    assert!(matches!(result, SendResult::Delivered { .. }), "{result:?}");
    let requests = fixture.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].path,
        format!("{ACCOUNTS_PATH}/{ACCOUNT_SID}{MESSAGES_SUFFIX}")
    );
    let body = String::from_utf8_lossy(&requests[0].body).to_string();
    assert!(body.contains("To=%2B15551234567"), "{body}");
    assert!(body.contains("From=%2B15559876543"), "{body}");
    let expected = envelope_text(&summary());
    let encoded = urlencoding(&expected);
    assert!(body.contains(&format!("Body={encoded}")), "{body}");
}

/// The form encoding `reqwest` applies to a value, for the assertion above.
fn urlencoding(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[tokio::test]
async fn the_send_authenticates_with_basic_auth_and_keeps_the_token_out_of_the_url() {
    let fixture = fixture_answering(FixtureState {
        status: 201,
        body: json!({ "sid": "SM123" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, TO_NUMBER));

    let _ = deliver(adapter, summary()).await;

    let send = fixture.requests().pop().expect("a send");
    let authorization = header_of(&send, "authorization").unwrap_or_default();
    assert!(authorization.starts_with("Basic "), "{authorization}");
    assert!(
        !send.path.contains(AUTH_TOKEN),
        "the token never travels in the path"
    );
}

#[tokio::test]
async fn a_refused_credential_is_terminal() {
    let fixture = fixture_answering(FixtureState {
        status: 401,
        body: json!({ "code": 20003, "message": "authenticate" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, TO_NUMBER));

    match deliver(adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Terminal);
            assert!(
                !detail.contains(AUTH_TOKEN),
                "the token never reaches a detail"
            );
        }
        other => panic!("expected a terminal refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn a_throttled_send_is_retryable() {
    let fixture = fixture_answering(FixtureState {
        status: 429,
        body: json!({ "code": 20429 }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, TO_NUMBER));

    match deliver(adapter, summary()).await {
        SendResult::Failed { kind, .. } => assert_eq!(kind, FailureKind::Retryable),
        other => panic!("expected a retryable refusal, got {other:?}"),
    }
}

#[test]
fn an_empty_destination_is_refused() {
    let error = configured_adapter(
        &record("https://api.twilio.com", "  "),
        ACCOUNT_SID,
        AUTH_TOKEN,
        FROM_NUMBER,
        true,
    )
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
