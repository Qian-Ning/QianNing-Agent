use super::*;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::{
    AdapterRegistry, AttemptOutcome, FailureKind, OutboundMessage, SendResult,
};
use crate::messaging_outbound::envelope_text;
use crate::messaging_outbound::fixture::{fixture, fixture_answering, FixtureState};
use crate::secrets::SecretStore;

/// A stored record in the shape the `messagingTelegram` settings section carries.
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
/// here exactly as the config-sync transport tests acknowledge theirs.
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

fn summary() -> OutboundMessage {
    OutboundMessage {
        id: "delivery-1".into(),
        channel: CHANNEL.into(),
        payload: json!({
            "eventId": "event-7",
            "kind": "turn.completed",
            "sessionId": "session-1",
            "turnId": "turn-1",
            "status": "completed",
            "revision": 12,
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

#[tokio::test]
async fn a_two_hundred_delivers_the_summary_as_json_to_the_send_path() {
    let fixture = fixture(200).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "s3cret-token", "9001", None));

    assert_eq!(
        deliver(&adapter, summary()).await,
        SendResult::Delivered { remote_id: None },
        "a 2xx is the receiver's acceptance"
    );

    let seen = fixture.requests();
    assert_eq!(seen.len(), 1, "one attempt, one request");
    let request = &seen[0];
    assert_eq!(request.method, "POST");
    assert_eq!(
        request.path, "/bots3cret-token/sendMessage",
        "the request addresses the platform's send method with the bot token in its path"
    );
    assert_eq!(
        request.content_type.as_deref(),
        Some("application/json"),
        "the summary is posted as JSON"
    );
    assert_eq!(
        request.authorization, None,
        "this platform carries the credential in the path, not a header"
    );

    let body: serde_json::Value =
        serde_json::from_slice(&request.body).expect("request body is JSON");
    assert_eq!(
        body,
        json!({ "chat_id": "9001", "text": envelope_text(&summary()) }),
        "the body carries the redacted summary to the configured chat"
    );

    fixture.stop();
}

#[tokio::test]
async fn a_two_hundred_family_status_other_than_200_delivers() {
    let fixture = fixture(204).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", "9001", None));

    assert_eq!(
        deliver(&adapter, summary()).await,
        SendResult::Delivered { remote_id: None },
        "every 2xx is the receiver's acceptance, not only 200"
    );
    assert_eq!(
        fixture.requests().len(),
        1,
        "the attempt reached the endpoint"
    );

    fixture.stop();
}

#[tokio::test]
async fn a_throttled_response_keeps_the_delivery_retryable() {
    let fixture = fixture(429).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", "9001", None));

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
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", "9001", None));

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
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", "9001", None));

    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(
                kind,
                FailureKind::Terminal,
                "the receiver refused this delivery, and a later attempt sends the same thing"
            );
            assert!(
                detail.contains("400"),
                "the status is named in the detail: {detail}"
            );
        }
        other => panic!("a 4xx refusal must not be accepted: {other:?}"),
    }

    fixture.stop();
}

#[tokio::test]
async fn a_timeout_keeps_the_delivery_retryable() {
    let fixture = fixture_answering(FixtureState {
        hang: true,
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", "9001", Some(300)));

    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Retryable);
            assert!(
                detail.contains("timed out"),
                "the failure names the timeout: {detail}"
            );
        }
        other => panic!("a timeout must not be accepted: {other:?}"),
    }
    assert_eq!(
        fixture.requests().len(),
        1,
        "the endpoint did receive the attempt it never answered"
    );

    fixture.stop();
}

#[tokio::test]
async fn a_malformed_response_ends_the_delivery_terminally() {
    let fixture = fixture_answering(FixtureState {
        malformed: true,
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", "9001", None));

    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(
                kind,
                FailureKind::Terminal,
                "an answer this client cannot accept will be answered the same way again"
            );
            assert!(
                detail.contains("malformed response"),
                "the failure names the malformed response: {detail}"
            );
        }
        other => panic!("a malformed response must not be accepted: {other:?}"),
    }

    fixture.stop();
}

#[tokio::test]
async fn a_refused_connection_keeps_the_delivery_retryable() {
    // Bind and release a loopback port so nothing is listening on it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind probe");
    let address = listener.local_addr().expect("probe address");
    drop(listener);

    let adapter = Arc::new(adapter(&format!("http://{address}"), "token", "9001", None));
    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Retryable);
            assert_eq!(
                detail, "the connection to the telegram endpoint failed",
                "a refused connection is the retryable connect failure, not a terminal one"
            );
        }
        other => panic!("a refused connection must not be accepted: {other:?}"),
    }
}

#[tokio::test]
async fn a_redirect_is_refused_rather_than_followed() {
    let fixture = fixture_answering(FixtureState {
        status: 302,
        redirect: true,
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, "token", "9001", None));

    match deliver(&adapter, summary()).await {
        SendResult::Failed { kind, detail } => {
            assert_eq!(
                kind,
                FailureKind::Terminal,
                "a redirected POST would move the credential elsewhere"
            );
            assert!(
                detail.contains("302"),
                "the status is named in the detail: {detail}"
            );
        }
        other => panic!("a redirect must not be accepted: {other:?}"),
    }
    assert_eq!(
        fixture.requests().len(),
        1,
        "the attempt stopped at the redirect"
    );
    assert_eq!(
        fixture.redirect_target_hits(),
        0,
        "the client never followed the Location to the second route"
    );

    fixture.stop();
}

#[test]
fn the_endpoint_rule_refuses_plaintext_to_a_public_host_and_any_userinfo() {
    let accepts = |endpoint: &str, allow: bool| {
        send_url(&record(endpoint, "9001", None), "token", allow).is_ok()
    };

    assert!(accepts("https://example.invalid", false));
    assert!(
        !accepts("http://example.invalid", true),
        "a public plaintext hop is refused in every mode, even relaxed"
    );
    assert!(accepts("http://127.0.0.1:9000", true));
    assert!(accepts("http://nas.local", true));
    assert!(
        !accepts("http://127.0.0.1:9000", false),
        "plaintext needs the relaxed policy even on loopback"
    );
    assert!(!accepts("https://user:pass@example.invalid", false));
    assert!(!accepts("ws://example.invalid", false));
    assert!(!accepts("https://", false));

    // The bot token reaches only the send path, and the configured address
    // carries no query or fragment for a request to leak.
    let url = send_url(
        &record("https://example.invalid?x=1#f", "9001", None),
        "T",
        false,
    )
    .expect("url");
    assert_eq!(url.path(), "/botT/sendMessage");
    assert_eq!(url.query(), None);
    assert_eq!(url.fragment(), None);
}

#[test]
fn an_unreadable_record_or_a_missing_credential_is_refused_rather_than_half_used() {
    let foreign = serde_json::from_value::<StoredConfig>(json!({
        "format": "some-other-format",
        "version": FORMAT_VERSION,
        "endpoint": "https://example.invalid",
        "destination": "9001",
    }))
    .expect("record");
    assert!(send_url(&foreign, "token", false).is_err());

    let future = serde_json::from_value::<StoredConfig>(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION + 1,
        "endpoint": "https://example.invalid",
        "destination": "9001",
    }))
    .expect("record");
    assert!(send_url(&future, "token", false).is_err());

    let too_short = serde_json::from_value::<StoredConfig>(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": "https://example.invalid",
        "destination": "9001",
        "requestTimeoutMs": 1,
    }))
    .expect("record");
    assert!(configured_adapter(&too_short, "token", false).is_err());

    let empty_token = record("https://example.invalid", "9001", None);
    assert!(configured_adapter(&empty_token, "   ", false).is_err());

    let empty_destination = record("https://example.invalid", "  ", None);
    assert!(configured_adapter(&empty_destination, "token", false).is_err());
}

#[test]
fn the_host_registers_the_configured_channel_and_nothing_when_unconfigured() {
    let (_dir, db, secrets) = host_settings();
    let mut registry = AdapterRegistry::new();

    // Unconfigured: the Host runs the same, with no channel registered.
    register(&mut registry, &db, &secrets).expect("register");
    assert!(
        registry.names().is_empty(),
        "a Host with no telegram record registers no channel"
    );

    // Configured, with the bot token in the secret store.
    db.set_setting("app", &settings_record("https://example.invalid", "9001"))
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

    // A configured record with no credential is reported, not registered.
    let mut missing_token = AdapterRegistry::new();
    secrets.delete(BOT_TOKEN_SECRET_REF).expect("delete secret");
    assert!(register(&mut missing_token, &db, &secrets).is_err());
    assert!(missing_token.names().is_empty());

    // A record the policy refuses is reported, not registered.
    let mut refused = AdapterRegistry::new();
    db.set_setting("app", &settings_record("http://example.invalid", "9001"))
        .expect("settings");
    assert!(register(&mut refused, &db, &secrets).is_err());
    assert!(refused.names().is_empty());
}

#[test]
fn several_configured_channels_coexist_in_one_registry() {
    let (_dir, db, secrets) = host_settings();
    db.set_setting(
        "app",
        &json!({
            "messagingWebhook": {
                "format": "pi-desktop-messaging-webhook",
                "version": 1,
                "endpoint": "https://example.invalid/hooks/pi",
            },
            SETTINGS_SECTION: {
                "format": FORMAT,
                "version": FORMAT_VERSION,
                "endpoint": "https://example.invalid",
                "destination": "9001",
            },
            "messagingSlack": {
                "format": "pi-desktop-messaging-slack",
                "version": 1,
                "endpoint": "https://example.invalid/api",
                "destination": "C0123",
            },
        }),
    )
    .expect("settings");
    secrets
        .set(BOT_TOKEN_SECRET_REF, "telegram-token")
        .expect("secret");
    secrets
        .set("secret:messaging-slack:bot-token", "slack-token")
        .expect("secret");

    let mut registry = AdapterRegistry::new();
    crate::messaging_webhook::register(&mut registry, &db, &secrets).expect("webhook");
    register(&mut registry, &db, &secrets).expect("telegram");
    crate::messaging_slack::register(&mut registry, &db, &secrets).expect("slack");

    assert_eq!(
        registry.names(),
        vec!["slack", "telegram", "webhook"],
        "every configured channel registers alongside the others, distinguished by its name"
    );
    for name in registry.names() {
        assert!(
            registry.get(name).is_some(),
            "the existing driver reaches channel '{name}' through the registry"
        );
    }
}

#[test]
fn the_channel_lifecycle_is_idempotent_and_releases_the_worker() {
    let record = record("https://example.invalid", "9001", None);
    let mut adapter = configured_adapter(&record, "token", false).expect("adapter");

    // Connecting twice keeps one worker instead of starting a second, and a
    // second connect after a release starts a fresh one.
    adapter.connect().expect("connect");
    adapter.connect().expect("connect is idempotent");
    adapter.disconnect().expect("disconnect");
    adapter.disconnect().expect("disconnect is idempotent");
    adapter.connect().expect("connect after a disconnect");

    // A released channel fails the attempt instead of waiting on a reply that
    // will never come.
    adapter.disconnect().expect("disconnect");
    assert_eq!(
        adapter.send(&summary()),
        SendResult::Failed {
            kind: FailureKind::Retryable,
            detail: "the telegram adapter is not connected".into()
        }
    );
}

#[tokio::test]
async fn the_bot_token_never_reaches_a_detail_a_debug_an_error_or_a_log_line() {
    const TOKEN: &str = "s3cret-token-value";

    // A real attempt carries the credential in the request path, and the failure
    // detail the ledger keeps must not echo it.
    let refusing = fixture(503).await;
    let adapter = Arc::new(adapter(&refusing.endpoint, TOKEN, "9001", None));
    let rendered = format!("{:?}", deliver(&adapter, summary()).await);
    assert!(
        !rendered.contains(TOKEN),
        "a failure detail must not carry the credential: {rendered}"
    );
    refusing.stop();

    // A configuration error must not echo the credential either, and no line
    // logged while the configuration is built may carry it.
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("telegram.log");
    let target = log_path.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || std::fs::File::create(&target).expect("log file"))
        .finish();
    let bad = record("ws://example.invalid", "9001", None);
    let error = tracing::subscriber::with_default(subscriber, || {
        send_url(&bad, TOKEN, false).expect_err("a non-HTTP scheme is refused")
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
}

/// A property test for the non-negotiable rule: no channel holds the host state
/// lock across a blocking send. It drives the real adapter through the Host's
/// own attempt-cycle driver, with the fixture holding the send in flight, and
/// asserts that unrelated host work needing the same lock still completes.
///
/// The negative control is to make the driver hold the lock across the send —
/// the assertion then fails because the lock is never free while the send waits.
#[tokio::test]
async fn the_attempt_cycle_releases_the_host_lock_across_a_blocking_send() {
    let fixture = fixture_answering(FixtureState {
        status: 200,
        gate: true,
        ..FixtureState::default()
    })
    .await;
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let db = Database::open_in_dir(dir.path()).expect("database");
        db.set_setting("app", &settings_record(&fixture.endpoint, "9001"))
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
        crate::messaging_adapter::enqueue_for(&st.db, &st.messaging, CHANNEL, summary().payload)
            .expect("enqueue")
            .id
    };

    // Run one cycle on a blocking thread of its own, where it blocks inside the
    // real channel's send. It is awaited rather than joined so this runtime
    // stays free to drive the fixture that must answer the request.
    let cycle = {
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(crate::rpc::messaging_rpc::drive_once(&state, "worker-a"))
        })
    };

    // The send is now in flight and has not returned.
    fixture.wait_for_request().await;

    // Host work that needs the same lock must complete: the cycle holds no
    // guarded state across the send.
    let acquired = tokio::time::timeout(Duration::from_secs(10), state.lock()).await;
    assert!(
        acquired.is_ok(),
        "the send must run with the host lock released"
    );
    drop(acquired);

    // Let the send finish; the cycle records the outcome as usual.
    fixture.release_one();
    let outcome = cycle.await.expect("cycle task").expect("cycle");
    assert_eq!(outcome, AttemptOutcome::Delivered { id: id.clone() });

    fixture.stop();
}

/// The indicator is a hint, not a delivery: it reaches the platform's own
/// action method with the chat it belongs to, and nothing about it is recorded.
#[tokio::test]
async fn typing_posts_the_platform_action_to_that_chat() {
    let fixture = fixture(200).await;
    let adapter = adapter(&fixture.endpoint, "s3cret-token", "9001", None);

    assert!(adapter.typing("9001"), "the hint is dispatched");

    // The request is made on the hint's own thread, so wait for it rather than
    // assume it has landed by the time `typing` returns.
    let mut seen = fixture.requests();
    for _ in 0..100 {
        if !seen.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        seen = fixture.requests();
    }
    assert_eq!(seen.len(), 1, "one hint, one request");
    let request = &seen[0];
    assert_eq!(request.method, "POST");
    assert_eq!(
        request.path, "/bots3cret-token/sendChatAction",
        "the hint addresses the platform's action method, not the send method"
    );
    let body: serde_json::Value =
        serde_json::from_slice(&request.body).expect("request body is JSON");
    assert_eq!(
        body,
        json!({ "chat_id": "9001", "action": "typing" }),
        "the body names the chat and the action, and carries no text"
    );
}

/// A channel that was never configured has no indicator to show, and says so
/// rather than pretending the request went somewhere.
#[test]
fn a_channel_without_a_hint_dispatches_nothing() {
    let adapter = HttpChannelAdapter::new("test");
    assert!(!adapter.typing("9001"));
}
