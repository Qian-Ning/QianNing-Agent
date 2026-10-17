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

/// The channel id the tests deliver to; a thread id reaches this same field.
const CHANNEL_ID: &str = "123456789012345678";

/// A stored record in the shape the `messagingDiscord` settings section carries.
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

/// The delivery text the fake transport received, as a JSON body.
fn body_of(request: &crate::messaging_outbound::fixture::SeenRequest) -> serde_json::Value {
    serde_json::from_slice(&request.body).expect("request body is JSON")
}

#[tokio::test]
async fn a_two_hundred_delivers_the_summary_to_the_channel_target() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "id": "987654321098765432" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "s3cret-token", CHANNEL_ID, None));

    assert_eq!(
        deliver(&adapter, summary()).await,
        SendResult::Delivered,
        "an HTTP 200 delivers the summary"
    );

    let seen = fixture.requests();
    assert_eq!(seen.len(), 1, "one attempt, one request");
    let request = &seen[0];
    assert_eq!(request.method, "POST");
    assert_eq!(
        request.path,
        format!("/channels/{CHANNEL_ID}/messages"),
        "the request addresses the platform's send method for the destination channel"
    );
    assert_eq!(
        request.content_type.as_deref(),
        Some("application/json"),
        "the summary is posted as JSON"
    );
    assert_eq!(
        request.authorization.as_deref(),
        Some("Bot s3cret-token"),
        "the bot token is sent with the scheme Discord's API specifies"
    );
    assert_eq!(
        body_of(request),
        json!({
            "content": envelope_text(&summary()),
            "allowed_mentions": { "parse": [] },
        }),
        "the body carries the redacted summary to the configured channel"
    );

    fixture.stop();
}

#[tokio::test]
async fn a_thread_id_is_the_target_of_the_reply() {
    // In Discord a thread is its own channel, so a thread id as `destination`
    // addresses the thread — the rule the inbound client applies when it
    // normalises a MESSAGE_CREATE from a thread.
    const THREAD_ID: &str = "223456789012345678";
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "id": "1" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", THREAD_ID, None));

    assert_eq!(deliver(&adapter, summary()).await, SendResult::Delivered);

    let seen = fixture.requests();
    assert_eq!(
        seen[0].path,
        format!("/channels/{THREAD_ID}/messages"),
        "a thread target is addressed as its own channel"
    );

    fixture.stop();
}

#[tokio::test]
async fn the_configured_base_path_survives_into_the_send_url() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "id": "1" }).to_string(),
        ..FixtureState::default()
    })
    .await;
    // The fixture's own address has no path, so the send URL adds the API path
    // on top of whatever base the record names.
    let adapter = Arc::new(adapter(
        &format!("{}/api/v10", fixture.endpoint),
        "token",
        CHANNEL_ID,
        None,
    ));

    assert_eq!(deliver(&adapter, summary()).await, SendResult::Delivered);
    assert_eq!(
        fixture.requests()[0].path,
        format!("/api/v10/channels/{CHANNEL_ID}/messages"),
        "the user's configured API base is preserved"
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
    let fixture = fixture(503).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", CHANNEL_ID, None));

    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Retryable);
            assert!(
                detail.contains("503"),
                "the status is named in the detail: {detail}"
            );
        }
        other => panic!("a 5xx must not be accepted: {other:?}"),
    }

    fixture.stop();
}

#[tokio::test]
async fn a_client_error_ends_the_delivery_terminally() {
    let fixture = fixture(400).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", CHANNEL_ID, None));

    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(
                kind,
                FailureKind::Terminal,
                "the receiver refused this delivery, and a later attempt sends the same thing"
            );
            assert!(detail.contains("400"), "the status is named: {detail}");
        }
        other => panic!("a 4xx refusal must not be accepted: {other:?}"),
    }

    fixture.stop();
}

#[test]
fn a_destination_is_a_path_segment_so_a_malformed_one_cannot_escape_the_route() {
    let url = send_url(
        &record("https://example.invalid/api/v10", "../guilds/1", None),
        false,
    )
    .expect("url");
    assert_eq!(
        url.path(),
        "/api/v10/channels/..%2Fguilds%2F1/messages",
        "the destination is encoded into one segment rather than reaching another route"
    );

    let empty = record("https://example.invalid/api/v10", "   ", None);
    assert!(
        send_url(&empty, false).is_err(),
        "an empty destination is refused rather than aimed at a channel-less route"
    );
    assert!(configured_adapter(&empty, "token", false).is_err());
}

#[test]
fn an_unreadable_record_or_an_empty_credential_is_refused_rather_than_half_used() {
    let foreign = serde_json::from_value::<StoredConfig>(json!({
        "format": "some-other-format",
        "version": FORMAT_VERSION,
        "endpoint": "https://example.invalid/api",
        "destination": CHANNEL_ID,
    }))
    .expect("record");
    assert!(send_url(&foreign, false).is_err());

    let future = serde_json::from_value::<StoredConfig>(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION + 1,
        "endpoint": "https://example.invalid/api",
        "destination": CHANNEL_ID,
    }))
    .expect("record");
    assert!(send_url(&future, false).is_err());

    let too_short = serde_json::from_value::<StoredConfig>(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": "https://example.invalid/api",
        "destination": CHANNEL_ID,
        "requestTimeoutMs": 1,
    }))
    .expect("record");
    assert!(configured_adapter(&too_short, "token", false).is_err());

    let empty_token = record("https://example.invalid/api", CHANNEL_ID, None);
    assert!(configured_adapter(&empty_token, "   ", false).is_err());
}

#[test]
fn the_host_registers_the_configured_channel_and_nothing_when_unconfigured() {
    let (_dir, db, secrets) = host_settings();
    let mut registry = AdapterRegistry::new();

    register(&mut registry, &db, &secrets).expect("register");
    assert!(
        registry.names().is_empty(),
        "a Host with no discord record registers no channel"
    );

    db.set_setting(
        "app",
        &settings_record("https://example.invalid/api/v10", CHANNEL_ID),
    )
    .expect("settings");
    secrets
        .set(BOT_TOKEN_SECRET_REF, "s3cret-token")
        .expect("secret");
    register(&mut registry, &db, &secrets).expect("register");
    assert_eq!(
        registry.names(),
        vec![CHANNEL],
        "the adapter is registered under the delivery channel it serves"
    );

    let mut missing_token = AdapterRegistry::new();
    secrets.delete(BOT_TOKEN_SECRET_REF).expect("delete secret");
    assert!(register(&mut missing_token, &db, &secrets).is_err());
    assert!(missing_token.names().is_empty());

    // With the credential back in place, the endpoint rule is what refuses.
    secrets
        .set(BOT_TOKEN_SECRET_REF, "s3cret-token")
        .expect("secret");
    let mut refused = AdapterRegistry::new();
    db.set_setting(
        "app",
        &settings_record("http://example.invalid/api", CHANNEL_ID),
    )
    .expect("settings");
    assert!(register(&mut refused, &db, &secrets).is_err());
    assert!(refused.names().is_empty());
}

#[tokio::test]
async fn the_bot_token_never_reaches_a_detail_an_error_or_a_log_line() {
    const TOKEN: &str = "s3cret-token-value";

    // A real attempt carries the credential in the Authorization header, and the
    // failure detail the ledger keeps must not echo it.
    let refusing = fixture(503).await;
    let adapter = Arc::new(adapter(&refusing.endpoint, TOKEN, CHANNEL_ID, None));
    let rendered = format!("{:?}", deliver(&adapter, summary()).await);
    assert!(
        !rendered.contains(TOKEN),
        "a failure detail must not carry the credential: {rendered}"
    );
    refusing.stop();

    // A configuration error must not echo the credential either, and no line
    // logged while the configuration is built may carry it.
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("discord.log");
    let target = log_path.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || std::fs::File::create(&target).expect("log file"))
        .finish();
    let bad = record("ws://example.invalid/api", CHANNEL_ID, None);
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

    // The header value redacts itself in Debug.
    let header =
        authorization_header(AUTHORIZATION_SCHEME, TOKEN, CODE, "bot token").expect("header");
    let debugged = format!("{header:?}");
    assert!(
        !debugged.contains(TOKEN) && debugged.contains("Sensitive"),
        "a sensitive header value redacts in Debug: {debugged}"
    );
}

/// The whole loop, through the Host's own state construction and attempt cycle:
/// the summary the relay enqueues under `discord` reaches the platform and the
/// ledger records the same transitions Telegram's deliveries take.
#[tokio::test]
async fn a_discord_delivery_reaches_the_wire_and_the_ledger_records_it_delivered() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        body: json!({ "id": "987654321098765432" }).to_string(),
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
            .set(BOT_TOKEN_SECRET_REF, "s3cret-token")
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
        let pending = delivery_ledger::get(&st.db, &id)
            .expect("read")
            .expect("the delivery is persisted");
        assert_eq!(
            pending.state,
            DeliveryState::Pending,
            "a hand-off starts the delivery pending, before any attempt"
        );
        assert_eq!(pending.attempts, 0, "no attempt has started yet");
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
    assert_eq!(seen.len(), 1, "the attempt reached the platform once");
    assert_eq!(
        seen[0].path,
        format!("/channels/{CHANNEL_ID}/messages"),
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
        body_of(&seen[0])["content"],
        json!(envelope_text(&delivered)),
        "the text that reached the wire is the redacted summary the relay enqueued"
    );

    {
        let st = state.lock().await;
        let stored = delivery_ledger::get(&st.db, &id)
            .expect("read")
            .expect("the delivery exists");
        assert_eq!(stored.state, DeliveryState::Delivered);
        assert_eq!(stored.attempts, 1, "the attempt is counted");
        assert!(stored.delivered_at.is_some(), "the delivery is stamped");
        assert_eq!(stored.channel, CHANNEL);
    }

    fixture.stop();
}

/// The failure path: a platform that answers "not now" leaves the entry the way
/// a Telegram failure leaves it — still pending, its error kept, its retry
/// scheduled — so the reply is never silently dropped.
#[tokio::test]
async fn a_throttled_discord_attempt_reschedules_the_delivery_and_keeps_the_error() {
    let fixture = fixture(429).await;
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let db = Database::open_in_dir(dir.path()).expect("database");
        db.set_setting("app", &settings_record(&fixture.endpoint, CHANNEL_ID))
            .expect("settings");
        let secrets = SecretStore::open(dir.path()).expect("secret store");
        secrets
            .set(BOT_TOKEN_SECRET_REF, "s3cret-token")
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
            assert!(error.contains("429"), "the throttle is named: {error}");
        }
        other => panic!("a 429 must be rescheduled, not dropped or delivered: {other:?}"),
    }

    {
        let st = state.lock().await;
        let stored = delivery_ledger::get(&st.db, &id)
            .expect("read")
            .expect("the delivery still exists");
        assert_eq!(
            stored.state,
            DeliveryState::Pending,
            "a throttled delivery stays claimable"
        );
        assert_eq!(stored.attempts, 1);
        assert!(
            stored.next_attempt_at.is_some(),
            "the ledger scheduled the retry"
        );
        assert!(
            stored
                .last_error
                .as_deref()
                .unwrap_or_default()
                .contains("429"),
            "the platform's answer is kept as the delivery's last error: {:?}",
            stored.last_error
        );
        assert!(stored.delivered_at.is_none());
    }

    fixture.stop();
}

/// A platform refusal no later attempt can clear ends the delivery terminally,
/// keeping the status-only detail and the credential out of it.
#[tokio::test]
async fn a_refused_discord_delivery_fails_terminally_without_echoing_the_token() {
    const TOKEN: &str = "s3cret-token-value";
    let fixture = fixture(403).await;
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let db = Database::open_in_dir(dir.path()).expect("database");
        db.set_setting("app", &settings_record(&fixture.endpoint, CHANNEL_ID))
            .expect("settings");
        let secrets = SecretStore::open(dir.path()).expect("secret store");
        secrets.set(BOT_TOKEN_SECRET_REF, TOKEN).expect("secret");
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
        AttemptOutcome::Failed { id: failed, error } => {
            assert_eq!(failed, id);
            assert!(error.contains("403"), "the status is named: {error}");
            assert!(
                !error.contains(TOKEN),
                "the detail must not echo the token: {error}"
            );
        }
        other => panic!("a 403 must end the delivery terminally: {other:?}"),
    }

    {
        let st = state.lock().await;
        let stored = delivery_ledger::get(&st.db, &id)
            .expect("read")
            .expect("the delivery exists");
        assert_eq!(stored.state, DeliveryState::Failed);
        assert!(stored.failed_at.is_some(), "the failure is stamped");
        assert_eq!(stored.attempts, 1, "a terminal refusal spends one attempt");
        let last_error = stored.last_error.unwrap_or_default();
        assert!(
            last_error.contains("403"),
            "the status is kept: {last_error}"
        );
        assert!(
            !last_error.contains(TOKEN),
            "the ledger's last error never carries the credential: {last_error}"
        );
    }

    fixture.stop();
}

/// The delivery text the ledger hands the platform is one bounded summary, well
/// inside Discord's per-message limit, which is why this channel posts one
/// request per attempt and leaves chunking to the reply send path that owns
/// Discord's message rule.
#[test]
fn the_delivery_text_fits_one_discord_message() {
    let worst_case = OutboundMessage {
        id: "d".repeat(64),
        channel: CHANNEL.into(),
        payload: json!({
            "eventId": "e".repeat(64),
            "kind": "turn.completed",
            "scope": "host",
            "sessionId": "s".repeat(64),
            "turnId": "t".repeat(64),
            "epoch": "p".repeat(64),
            "sequence": 9_999_999,
            "revision": 9_999_999,
            "status": "completed",
            "agentName": "a".repeat(64),
            "occurredAt": "2026-10-17T00:00:00Z",
        }),
        redelivery: true,
    };
    let text = envelope_text(&worst_case);
    assert!(
        text.chars().count() <= 2000,
        "a maximal summary is {} characters, inside Discord's 2000: one post is the whole delivery",
        text.chars().count()
    );
}
