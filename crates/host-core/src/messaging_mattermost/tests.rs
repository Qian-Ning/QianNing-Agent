use super::*;

use std::sync::Arc;

use serde_json::json;

use crate::db::Database;
use crate::delivery_ledger::{self, DeliveryState};
use crate::messaging_adapter::{
    AdapterRegistry, AttemptOutcome, FailureKind, OutboundMessage, SendResult,
};
use crate::messaging_outbound::envelope_text;
use crate::messaging_outbound::fixture::{fixture, fixture_answering, FixtureState};
use crate::secrets::SecretStore;

/// The channel id the tests deliver to.
const CHANNEL_ID: &str = "8f3k1mnoq7fg9y5d1a2b3c4d5e";

/// A stored record in the shape the `messagingMattermost` settings section
/// carries.
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
fn adapter(
    endpoint: &str,
    token: &str,
    destination: &str,
    timeout: Option<u64>,
) -> HttpChannelAdapter {
    configured_adapter(&record(endpoint, destination, timeout), token, true).expect("adapter")
}

/// Drive one attempt the way the Host does — synchronously — but off the
/// runtime's worker thread, so the fixture sharing this current-thread runtime
/// can still answer it.
async fn deliver(adapter: &Arc<HttpChannelAdapter>, message: OutboundMessage) -> SendResult {
    let adapter = adapter.clone();
    tokio::task::spawn_blocking(move || adapter.send(&message))
        .await
        .expect("send task")
}

/// The redacted summary the relay hands the ledger for one completed turn, in
/// the shape `MessagingRedactor` builds it.
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

/// The stored settings a configured Host carries.
fn settings_record(endpoint: &str, destination: &str) -> serde_json::Value {
    json!({
        SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": endpoint,
            "destination": destination,
        }
    })
}

fn host_settings() -> (tempfile::TempDir, Database, SecretStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    (dir, db, secrets)
}

/// The delivery body the fake transport received, as JSON.
fn body_of(request: &crate::messaging_outbound::fixture::SeenRequest) -> serde_json::Value {
    serde_json::from_slice(&request.body).expect("request body is JSON")
}

#[tokio::test]
async fn a_two_hundred_delivers_the_summary_to_the_channel_target() {
    let fixture = fixture_answering(FixtureState {
        status: 201,
        body: json!({ "id": "post-1" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "s3cret-token", CHANNEL_ID, None));

    assert_eq!(
        deliver(&adapter, summary()).await,
        SendResult::Delivered,
        "a 2xx delivers the summary; Mattermost answers a created post with 201"
    );

    let seen = fixture.requests();
    assert_eq!(seen.len(), 1, "one attempt, one request");
    let request = &seen[0];
    assert_eq!(request.method, "POST");
    assert_eq!(
        request.path, "/api/v4/posts",
        "the request addresses the platform's post API"
    );
    assert_eq!(
        request.content_type.as_deref(),
        Some("application/json"),
        "the summary is posted as JSON"
    );
    assert_eq!(
        request.authorization.as_deref(),
        Some("Bearer s3cret-token"),
        "the access token is sent as a bearer credential"
    );
    assert_eq!(
        body_of(request),
        json!({
            "channel_id": CHANNEL_ID,
            "message": envelope_text(&summary()),
        }),
        "the body carries the redacted summary to the configured channel"
    );

    fixture.stop();
}

#[tokio::test]
async fn the_configured_base_path_survives_into_the_send_url() {
    let fixture = fixture_answering(FixtureState {
        status: 201,
        body: json!({ "id": "post-1" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    // A reverse proxy under `/chat` must keep its prefix.
    let adapter = Arc::new(adapter(
        &format!("{}/chat", fixture.endpoint),
        "token",
        CHANNEL_ID,
        None,
    ));

    assert_eq!(deliver(&adapter, summary()).await, SendResult::Delivered);
    assert_eq!(
        fixture.requests()[0].path,
        "/chat/api/v4/posts",
        "the user's configured base path is preserved"
    );

    fixture.stop();
}

#[tokio::test]
async fn a_throttled_response_keeps_the_delivery_retryable() {
    let fixture = fixture(429).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", CHANNEL_ID, None));

    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Retryable);
            assert!(
                detail.contains("429"),
                "the status is named in the detail: {detail}"
            );
        }
        other => panic!("429 must not be accepted: {other:?}"),
    }

    fixture.stop();
}

#[tokio::test]
async fn a_server_error_keeps_the_delivery_retryable() {
    let fixture = fixture(502).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", CHANNEL_ID, None));

    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Retryable);
            assert!(
                detail.contains("502"),
                "the status is named in the detail: {detail}"
            );
        }
        other => panic!("a 5xx must not be accepted: {other:?}"),
    }

    fixture.stop();
}

#[tokio::test]
async fn a_client_error_ends_the_delivery_terminally() {
    let fixture = fixture(401).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", CHANNEL_ID, None));

    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(
                kind,
                FailureKind::Terminal,
                "a refused credential is not a condition a later attempt clears"
            );
            assert!(detail.contains("401"), "the status is named: {detail}");
        }
        other => panic!("a 4xx refusal must not be accepted: {other:?}"),
    }

    fixture.stop();
}

#[test]
fn an_unreadable_record_or_an_empty_credential_is_refused_rather_than_half_used() {
    let foreign = serde_json::from_value::<StoredConfig>(json!({
        "format": "some-other-format",
        "version": FORMAT_VERSION,
        "endpoint": "https://example.invalid",
        "destination": CHANNEL_ID,
    }))
    .expect("record");
    assert!(send_url(&foreign, false).is_err());

    let future = serde_json::from_value::<StoredConfig>(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION + 1,
        "endpoint": "https://example.invalid",
        "destination": CHANNEL_ID,
    }))
    .expect("record");
    assert!(send_url(&future, false).is_err());

    let too_short = serde_json::from_value::<StoredConfig>(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": "https://example.invalid",
        "destination": CHANNEL_ID,
        "requestTimeoutMs": 1,
    }))
    .expect("record");
    assert!(configured_adapter(&too_short, "token", false).is_err());

    assert!(
        configured_adapter(
            &record("https://example.invalid", CHANNEL_ID, None),
            "   ",
            false
        )
        .is_err(),
        "an empty access token is refused rather than sent as an empty header"
    );
    assert!(
        configured_adapter(
            &record("https://example.invalid", "  ", None),
            "token",
            false
        )
        .is_err(),
        "an empty destination is refused"
    );
}

#[test]
fn the_host_registers_the_configured_channel_and_nothing_when_unconfigured() {
    let (_dir, db, secrets) = host_settings();
    let mut registry = AdapterRegistry::new();

    register(&mut registry, &db, &secrets).expect("register");
    assert!(
        registry.names().is_empty(),
        "a Host with no mattermost record registers no channel"
    );

    db.set_setting(
        "app",
        &settings_record("https://example.invalid", CHANNEL_ID),
    )
    .expect("settings");
    secrets
        .set(ACCESS_TOKEN_SECRET_REF, "s3cret-token")
        .expect("secret");
    register(&mut registry, &db, &secrets).expect("register");
    assert_eq!(
        registry.names(),
        vec![CHANNEL],
        "the adapter is registered under the delivery channel it serves"
    );

    let mut missing_token = AdapterRegistry::new();
    secrets
        .delete(ACCESS_TOKEN_SECRET_REF)
        .expect("delete secret");
    assert!(register(&mut missing_token, &db, &secrets).is_err());
    assert!(missing_token.names().is_empty());

    // With the credential back in place, the endpoint rule is what refuses.
    secrets
        .set(ACCESS_TOKEN_SECRET_REF, "s3cret-token")
        .expect("secret");
    let mut refused = AdapterRegistry::new();
    db.set_setting(
        "app",
        &settings_record("http://example.invalid", CHANNEL_ID),
    )
    .expect("settings");
    assert!(register(&mut refused, &db, &secrets).is_err());
    assert!(refused.names().is_empty());
}

#[tokio::test]
async fn the_access_token_never_reaches_a_detail_an_error_or_a_log_line() {
    const TOKEN: &str = "s3cret-token-value";

    let refusing = fixture(503).await;
    let adapter = Arc::new(adapter(&refusing.endpoint, TOKEN, CHANNEL_ID, None));
    let rendered = format!("{:?}", deliver(&adapter, summary()).await);
    assert!(
        !rendered.contains(TOKEN),
        "a failure detail must not carry the credential: {rendered}"
    );
    refusing.stop();

    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("mattermost.log");
    let target = log_path.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || std::fs::File::create(&target).expect("log file"))
        .finish();
    let bad = record("ws://example.invalid", CHANNEL_ID, None);
    let error = tracing::subscriber::with_default(subscriber, || {
        configured_adapter(&bad, TOKEN, false)
            .err()
            .expect("a non-HTTP scheme is refused")
    });
    assert!(
        !error.to_string().contains(TOKEN),
        "a configuration error must not echo the credential: {error}"
    );
    let logged = std::fs::read_to_string(&log_path).unwrap_or_default();
    assert!(
        !logged.contains(TOKEN),
        "no log line may carry the credential: {logged}"
    );

    let header = authorization_header("Bearer", TOKEN, CODE, "access token").expect("header");
    let debugged = format!("{header:?}");
    assert!(
        !debugged.contains(TOKEN) && debugged.contains("Sensitive"),
        "a sensitive header value redacts in Debug: {debugged}"
    );
}

/// The whole loop through the Host's own state construction and attempt cycle:
/// the summary the relay enqueues under `mattermost` reaches the platform and
/// the ledger records the delivery.
#[tokio::test]
async fn a_mattermost_delivery_reaches_the_wire_and_the_ledger_records_it_delivered() {
    let fixture = fixture_answering(FixtureState {
        status: 201,
        body: json!({ "id": "post-1" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let db = Database::open_in_dir(dir.path()).expect("database");
        db.set_setting("app", &settings_record(&fixture.endpoint, CHANNEL_ID))
            .expect("settings");
        let secrets = SecretStore::open(dir.path()).expect("secret store");
        secrets
            .set(ACCESS_TOKEN_SECRET_REF, "s3cret-token")
            .expect("secret");
    }

    let state = Arc::new(tokio::sync::Mutex::new(
        crate::state::AppState::open(dir.path()).expect("app state"),
    ));
    let id = {
        let st = state.lock().await;
        assert_eq!(
            st.messaging.names(),
            vec![CHANNEL],
            "state construction registered the configured channel"
        );
        let id = crate::messaging_adapter::enqueue_for(
            &st.db,
            &st.messaging,
            CHANNEL,
            summary().payload,
        )
        .expect("enqueue")
        .id;
        assert_eq!(
            delivery_ledger::get(&st.db, &id)
                .expect("read")
                .expect("persisted")
                .state,
            DeliveryState::Pending,
            "a hand-off starts the delivery pending"
        );
        id
    };

    let outcome = {
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(crate::rpc::messaging_rpc::drive_once(&state, "worker-a"))
        })
        .await
        .expect("cycle task")
        .expect("cycle")
    };
    assert_eq!(
        outcome,
        AttemptOutcome::Delivered { id: id.clone() },
        "the attempt cycle delivered the summary through the registered channel"
    );

    let seen = fixture.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/api/v4/posts");
    let body = body_of(&seen[0]);
    assert_eq!(
        body["channel_id"],
        json!(CHANNEL_ID),
        "the target is the configured channel"
    );
    // The ledger mints the delivery id, so the envelope the wire carries is the
    // enqueued summary under that id.
    let delivered = OutboundMessage {
        id: id.clone(),
        channel: CHANNEL.into(),
        payload: summary().payload,
        redelivery: false,
    };
    assert_eq!(
        body["message"],
        json!(envelope_text(&delivered)),
        "the text that reached the wire is the redacted summary the relay enqueued"
    );
    assert!(
        body.get("root_id").is_none(),
        "a channel-level delivery carries no thread id, exactly as the inbound send path omits it"
    );

    {
        let st = state.lock().await;
        let stored = delivery_ledger::get(&st.db, &id)
            .expect("read")
            .expect("the delivery exists");
        assert_eq!(stored.state, DeliveryState::Delivered);
        assert_eq!(stored.attempts, 1);
        assert!(stored.delivered_at.is_some());
        assert_eq!(stored.channel, CHANNEL);
    }

    fixture.stop();
}

/// A 5xx from the platform leaves the entry exactly where a Telegram failure
/// leaves it: pending, error kept, retry scheduled — never dropped.
#[tokio::test]
async fn a_failing_mattermost_attempt_reschedules_the_delivery_and_keeps_the_error() {
    let fixture = fixture(503).await;
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let db = Database::open_in_dir(dir.path()).expect("database");
        db.set_setting("app", &settings_record(&fixture.endpoint, CHANNEL_ID))
            .expect("settings");
        let secrets = SecretStore::open(dir.path()).expect("secret store");
        secrets
            .set(ACCESS_TOKEN_SECRET_REF, "s3cret-token")
            .expect("secret");
    }

    let state = Arc::new(tokio::sync::Mutex::new(
        crate::state::AppState::open(dir.path()).expect("app state"),
    ));
    let id = {
        let st = state.lock().await;
        crate::messaging_adapter::enqueue_for(&st.db, &st.messaging, CHANNEL, summary().payload)
            .expect("enqueue")
            .id
    };

    let outcome = {
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(crate::rpc::messaging_rpc::drive_once(&state, "worker-a"))
        })
        .await
        .expect("cycle task")
        .expect("cycle")
    };
    match outcome {
        AttemptOutcome::Retried { id: retried, error } => {
            assert_eq!(retried, id);
            assert!(error.contains("503"), "the status is named: {error}");
        }
        other => panic!("a 5xx must be rescheduled, not dropped or delivered: {other:?}"),
    }

    {
        let st = state.lock().await;
        let stored = delivery_ledger::get(&st.db, &id)
            .expect("read")
            .expect("the delivery still exists");
        assert_eq!(stored.state, DeliveryState::Pending);
        assert_eq!(stored.attempts, 1);
        assert!(stored.next_attempt_at.is_some(), "the retry is scheduled");
        assert!(stored
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("503"));
        assert!(stored.delivered_at.is_none());
    }

    fixture.stop();
}
