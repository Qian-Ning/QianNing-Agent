use super::*;

use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A request the fixture actually received.
#[derive(Clone, Debug, PartialEq)]
struct SeenRequest {
    method: String,
    path: String,
    content_type: Option<String>,
    authorization: Option<String>,
    body: Vec<u8>,
}

/// What the fixture answers, and what it saw. Hand-written like the
/// config-sync transport fixture, and reachable only over loopback.
#[derive(Default)]
struct FixtureState {
    status: u16,
    /// Answer with bytes that are not an HTTP response at all.
    malformed: bool,
    /// Accept the request and never answer it.
    hang: bool,
    /// Accept the connection and close it without answering.
    slam: bool,
    /// Accept the connection and close it without reading a thing.
    reject: bool,
    /// Answer a 3xx with a `Location` naming this fixture's second route, so a
    /// client that follows redirects reaches it and a client that does not
    /// never does.
    redirect: bool,
    /// The absolute URL an answer's `Location` names, set from the bound
    /// address when [`FixtureState::redirect`] is on.
    location: Option<String>,
    /// How many requests reached the route `location` names. A following client
    /// records one; the configured client records none.
    redirect_target_hits: usize,
    requests: Vec<SeenRequest>,
}

async fn read_request(stream: &mut TcpStream) -> Option<SeenRequest> {
    let mut buffer = Vec::new();
    let header_end;
    loop {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|value| value == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
        if buffer.len() > 64 * 1024 {
            return None;
        }
    }
    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request = lines.next()?.split_whitespace();
    let method = request.next()?.to_string();
    let target = request.next()?.to_string();
    let mut content_length = 0usize;
    let mut content_type = None;
    let mut authorization = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_string();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.parse().unwrap_or(0),
            "content-type" => content_type = Some(value),
            "authorization" => authorization = Some(value),
            _ => {}
        }
    }
    while buffer.len() < header_end + content_length {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some(SeenRequest {
        method,
        path: target.split('?').next().unwrap_or_default().to_string(),
        content_type,
        authorization,
        body: buffer[header_end..header_end + content_length].to_vec(),
    })
}

async fn write_response(stream: &mut TcpStream, status: u16, location: Option<&str>) {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Unknown",
    };
    let location = location
        .map(|value| format!("Location: {value}\r\n"))
        .unwrap_or_default();
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\n{location}Connection: close\r\n\r\n"
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn handle_connection(mut stream: TcpStream, state: Arc<Mutex<FixtureState>>) {
    if state.lock().expect("fixture state").reject {
        // Close before reading: a TLS client's handshake fails at once instead
        // of waiting out its connect timeout on a peer that answers nothing.
        let _ = stream.shutdown().await;
        return;
    }
    let Some(request) = read_request(&mut stream).await else {
        return;
    };
    let (status, malformed, hang, location) = {
        let mut state = state.lock().expect("fixture state");
        let reached_redirect_target = state
            .location
            .as_deref()
            .and_then(|url| Url::parse(url).ok())
            .is_some_and(|url| url.path() == request.path);
        state.requests.push(request);
        if reached_redirect_target {
            // The redirect target accepts: reaching it is exactly what the
            // configured client must never do, so the hit is recorded (as every
            // request is) and answered with an acceptance.
            state.redirect_target_hits += 1;
            (200, false, false, None)
        } else {
            (
                state.status,
                state.malformed,
                state.hang,
                state.location.clone(),
            )
        }
    };
    if state.lock().expect("fixture state").slam {
        // Accept the connection and close it without ever answering, so the
        // client fails while it is still sending.
        let _ = stream.shutdown().await;
        return;
    }
    if malformed {
        let _ = stream.write_all(b"NOT-HTTP\r\n\r\n").await;
        let _ = stream.shutdown().await;
        return;
    }
    if hang {
        // Hold the connection open and never answer, so the client's own
        // timeout is the only thing that ends the attempt.
        std::future::pending::<()>().await;
        return;
    }
    write_response(&mut stream, status, location.as_deref()).await;
}

struct Fixture {
    endpoint: String,
    state: Arc<Mutex<FixtureState>>,
    task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    fn requests(&self) -> Vec<SeenRequest> {
        self.state.lock().expect("fixture state").requests.clone()
    }

    fn redirect_target_hits(&self) -> usize {
        self.state
            .lock()
            .expect("fixture state")
            .redirect_target_hits
    }

    fn stop(self) {
        self.task.abort();
    }
}

async fn fixture(status: u16) -> Fixture {
    fixture_answering(FixtureState {
        status,
        ..FixtureState::default()
    })
    .await
}

async fn fixture_answering(mut state: FixtureState) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    if state.redirect {
        // The redirect names a second route on this same fixture, so a client
        // that follows it is recorded here rather than leaving the fixture.
        state.location = Some(format!("http://{address}/hooks/pi/redirected"));
    }
    let state = Arc::new(Mutex::new(state));
    let task = tokio::spawn({
        let state = state.clone();
        async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(handle_connection(stream, state.clone()));
            }
        }
    });
    Fixture {
        endpoint: format!("http://{address}/hooks/pi"),
        state,
        task,
    }
}

/// A connected adapter aimed at `endpoint`, built through the same record
/// shape the settings carry. The plaintext hop is acknowledged here exactly
/// as the config-sync transport tests acknowledge theirs.
fn adapter(endpoint: &str, token: Option<&str>, request_timeout_ms: Option<u64>) -> WebhookAdapter {
    let record: StoredConfig = serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": endpoint,
        "requestTimeoutMs": request_timeout_ms,
    }))
    .expect("record");
    let config =
        WebhookConfig::from_record(&record, token.map(str::to_string), true).expect("config");
    let mut adapter = WebhookAdapter::new().configure(config);
    adapter.connect().expect("connect");
    adapter
}

/// Drive one attempt the way the Host does — synchronously — but off the
/// runtime's worker thread, so the fixture sharing this current-thread
/// runtime can still answer it. A blocked worker with the fixture behind it
/// would deadlock, which is exactly the constraint the production design
/// pays for with its bounded wait.
async fn deliver(adapter: &Arc<WebhookAdapter>, message: OutboundMessage) -> SendResult {
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

#[tokio::test]
async fn a_two_hundred_delivers_the_summary_as_json_to_the_configured_path() {
    let fixture = fixture(200).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, Some("s3cret-token"), None));

    assert_eq!(
        deliver(&adapter, summary()).await,
        SendResult::Delivered,
        "a 2xx is the receiver's acceptance"
    );

    let seen = fixture.requests();
    assert_eq!(seen.len(), 1, "one attempt, one request");
    let request = &seen[0];
    assert_eq!(request.method, "POST");
    assert_eq!(
        request.path, "/hooks/pi",
        "the request addresses the configured path"
    );
    assert_eq!(
        request.content_type.as_deref(),
        Some("application/json"),
        "the summary is posted as JSON"
    );
    assert_eq!(
        request.authorization.as_deref(),
        Some("Bearer s3cret-token"),
        "the configured token is sent as a bearer credential"
    );

    let body: serde_json::Value =
        serde_json::from_slice(&request.body).expect("request body is JSON");
    assert_eq!(
        body,
        json!({
            "deliveryId": "delivery-1",
            "channel": CHANNEL,
            "redelivery": false,
            "summary": summary().payload,
        }),
        "the body carries the redacted summary verbatim plus the correlation fields"
    );

    fixture.stop();
}

#[tokio::test]
async fn a_server_error_keeps_the_delivery_retryable() {
    let fixture = fixture(503).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, None, None));

    let result = deliver(&adapter, summary()).await;
    match result {
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
async fn a_throttled_response_keeps_the_delivery_retryable() {
    let fixture = fixture(429).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, None, None));

    let result = deliver(&adapter, summary()).await;
    match result {
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
async fn a_client_error_ends_the_delivery_terminally() {
    let fixture = fixture(400).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, None, None));

    let result = deliver(&adapter, summary()).await;
    match result {
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
async fn a_redirect_is_refused_rather_than_followed() {
    // The 302 names a second route on this fixture, so a client that followed
    // the redirect would reach it and be recorded. The client is built with
    // redirects disabled, so a 3xx is answered here as a status the
    // classification refuses: following it would carry the bearer token to
    // whatever host the endpoint named next.
    let fixture = fixture_answering(FixtureState {
        status: 302,
        redirect: true,
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, Some("s3cret-token"), None));

    let result = deliver(&adapter, summary()).await;
    match result {
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
        "the attempt stopped at the redirect and never sent a second request"
    );
    assert_eq!(
        fixture.redirect_target_hits(),
        0,
        "the client never followed the Location to the second route"
    );

    fixture.stop();
}

#[tokio::test]
async fn a_two_hundred_family_status_other_than_200_delivers() {
    let fixture = fixture(204).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, None, None));

    assert_eq!(
        deliver(&adapter, summary()).await,
        SendResult::Delivered,
        "every 2xx is the receiver's acceptance, not only 200"
    );
    let seen = fixture.requests();
    assert_eq!(seen.len(), 1, "the attempt reached the endpoint");
    let body: serde_json::Value =
        serde_json::from_slice(&seen[0].body).expect("request body is JSON");
    assert_eq!(
        body,
        json!({
            "deliveryId": "delivery-1",
            "channel": CHANNEL,
            "redelivery": false,
            "summary": summary().payload,
        }),
        "the accepted attempt posted the redacted summary as JSON with the delivery metadata"
    );

    fixture.stop();
}

#[tokio::test]
async fn a_timeout_keeps_the_delivery_retryable() {
    let fixture = fixture_answering(FixtureState {
        hang: true,
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, None, Some(300)));

    let result = deliver(&adapter, summary()).await;
    match result {
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
    let adapter = Arc::new(adapter(&fixture.endpoint, None, None));

    let result = deliver(&adapter, summary()).await;
    match result {
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
async fn a_connection_closed_before_it_answers_is_not_mistaken_for_an_acceptance() {
    let fixture = fixture_answering(FixtureState {
        slam: true,
        ..FixtureState::default()
    })
    .await;
    let adapter = Arc::new(adapter(&fixture.endpoint, None, None));

    let result = deliver(&adapter, summary()).await;
    match result {
        SendResult::Failed { kind, detail } => {
            // The client this Host has reports a connection closed before the
            // response completed as the same error as a response it cannot
            // parse — `is_request`, with no connection or timeout marker — so
            // the two share one classification and the detail says which two
            // cases it covers instead of guessing between them.
            assert_eq!(kind, FailureKind::Terminal);
            assert!(
                detail.contains("malformed response or closed the connection"),
                "the detail names both cases it covers: {detail}"
            );
        }
        other => panic!("a closed connection must not be accepted: {other:?}"),
    }

    fixture.stop();
}

#[tokio::test]
async fn a_tls_failure_is_a_transport_failure_and_not_an_acceptance() {
    // The fixture speaks plaintext HTTP and closes the connection at once, so
    // aiming a TLS endpoint at it fails the handshake — a transport failure
    // distinct from a refused connection, and one that must never read as a
    // delivery.
    let fixture = fixture_answering(FixtureState {
        reject: true,
        ..FixtureState::default()
    })
    .await;
    let endpoint = fixture.endpoint.replacen("http://", "https://", 1);
    let adapter = Arc::new(adapter(&endpoint, None, Some(500)));

    let result = deliver(&adapter, summary()).await;
    match result {
        SendResult::Failed { kind, detail } => {
            assert_eq!(
                kind,
                FailureKind::Retryable,
                "a failed handshake is a transport failure, not a refusal of the delivery: {detail}"
            );
            assert!(
                matches!(
                    detail.as_str(),
                    "the connection to the webhook endpoint failed"
                        | "the webhook request timed out"
                        | "the webhook response body could not be read"
                ),
                "the failure names a retryable transport reason: {detail}"
            );
        }
        other => panic!("a failed handshake must not be accepted: {other:?}"),
    }
    assert!(
        fixture.requests().is_empty(),
        "the TLS client never delivers an HTTP request to the fixture"
    );

    fixture.stop();
}

#[tokio::test]
async fn a_refused_connection_keeps_the_delivery_retryable() {
    // Bind and release a loopback port so nothing is listening on it.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind probe");
    let address = listener.local_addr().expect("probe address");
    drop(listener);

    let adapter = Arc::new(adapter(&format!("http://{address}/hooks/pi"), None, None));
    let result = deliver(&adapter, summary()).await;
    match result {
        SendResult::Failed { kind, detail } => {
            assert_eq!(kind, FailureKind::Retryable);
            assert_eq!(
                detail, "the connection to the webhook endpoint failed",
                "a refused connection is the retryable connect failure, not a terminal one"
            );
        }
        other => panic!("a refused connection must not be accepted: {other:?}"),
    }
}

#[tokio::test]
async fn a_host_with_no_token_posts_without_an_authorization_header() {
    let fixture = fixture(200).await;
    let adapter = Arc::new(adapter(&fixture.endpoint, None, None));

    assert_eq!(deliver(&adapter, summary()).await, SendResult::Delivered);
    let seen = fixture.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0].authorization, None,
        "an unconfigured token means no credential is invented"
    );

    fixture.stop();
}

#[test]
fn an_unconfigured_adapter_refuses_to_connect_and_never_sends_anywhere() {
    let mut adapter = WebhookAdapter::new();
    let error = adapter.connect().expect_err("connect must refuse");
    assert!(
        error
            .to_string()
            .contains("MESSAGING_WEBHOOK_NOT_CONFIGURED"),
        "the refusal names the configuration: {error}"
    );
    assert_eq!(
        adapter.send(&summary()),
        SendResult::Failed {
            kind: FailureKind::Retryable,
            detail: "the webhook adapter is not connected".into()
        },
        "a channel that was never connected fails the attempt instead of inventing an acceptance"
    );
    adapter
        .disconnect()
        .expect("disconnect is safe when unconnected");
}

#[test]
fn the_channel_lifecycle_is_idempotent_and_releases_the_worker() {
    let record: StoredConfig = serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": "https://example.invalid/hooks/pi",
    }))
    .expect("record");
    let config = WebhookConfig::from_record(&record, Some("token".into()), false).expect("config");
    let mut adapter = WebhookAdapter::new().configure(config);

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
            detail: "the webhook adapter is not connected".into()
        }
    );
}

#[test]
fn the_endpoint_rule_refuses_plaintext_to_a_public_host_and_any_userinfo() {
    let record = |endpoint: &str| -> StoredConfig {
        serde_json::from_value(json!({
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": endpoint,
        }))
        .expect("record")
    };
    let accepts = |endpoint: &str, allow_insecure: bool| {
        WebhookConfig::from_record(&record(endpoint), None, allow_insecure).is_ok()
    };

    assert!(accepts("https://example.invalid/hooks/pi", false));
    assert!(
        !accepts("http://example.invalid/hooks/pi", true),
        "a public plaintext hop is refused in every mode, even relaxed"
    );
    assert!(!accepts("http://example.invalid/hooks/pi", false));
    assert!(accepts("http://127.0.0.1:9000/hooks/pi", true));
    assert!(accepts("http://nas.local/hooks/pi", true));
    assert!(
        !accepts("http://127.0.0.1:9000/hooks/pi", false),
        "plaintext needs the relaxed policy even on loopback"
    );
    assert!(!accepts(
        "https://user:pass@example.invalid/hooks/pi",
        false
    ));
    assert!(!accepts("ws://example.invalid/hooks/pi", false));
    assert!(!accepts("https://", false));

    let config =
        WebhookConfig::from_record(&record("https://example.invalid/hooks/pi"), None, false)
            .expect("config");
    assert_eq!(
        config.endpoint.query(),
        None,
        "the configured address carries no query for a request to leak"
    );
}

#[test]
fn an_unreadable_record_is_refused_rather_than_half_used() {
    let foreign = serde_json::from_value::<StoredConfig>(json!({
        "format": "some-other-format",
        "version": FORMAT_VERSION,
        "endpoint": "https://example.invalid/hooks/pi",
    }))
    .expect("record");
    assert!(WebhookConfig::from_record(&foreign, None, false).is_err());

    let future = serde_json::from_value::<StoredConfig>(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION + 1,
        "endpoint": "https://example.invalid/hooks/pi",
    }))
    .expect("record");
    assert!(WebhookConfig::from_record(&future, None, false).is_err());

    let too_short = serde_json::from_value::<StoredConfig>(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": "https://example.invalid/hooks/pi",
        "requestTimeoutMs": 1,
    }))
    .expect("record");
    assert!(WebhookConfig::from_record(&too_short, None, false).is_err());
}

/// The stored settings a configured Host carries.
fn settings_record(endpoint: &str) -> serde_json::Value {
    json!({
        SETTINGS_SECTION: {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "endpoint": endpoint,
        }
    })
}

fn host_settings() -> (tempfile::TempDir, Database, SecretStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open_in_dir(dir.path()).expect("database");
    let secrets = SecretStore::open(dir.path()).expect("secret store");
    (dir, db, secrets)
}

#[test]
fn the_host_registers_the_configured_channel_and_nothing_when_unconfigured() {
    let (_dir, db, secrets) = host_settings();
    let mut registry = AdapterRegistry::new();

    // Unconfigured: the Host runs the same, with no channel registered.
    register(&mut registry, &db, &secrets).expect("register");
    assert!(
        registry.names().is_empty(),
        "a Host with no webhook record registers no channel"
    );
    assert!(registry.get(CHANNEL).is_none());

    // Configured, with the optional token in the secret store.
    db.set_setting("app", &settings_record("https://example.invalid/hooks/pi"))
        .expect("settings");
    secrets
        .set(BEARER_TOKEN_SECRET_REF, "s3cret-token")
        .expect("secret");

    register(&mut registry, &db, &secrets).expect("register");
    assert_eq!(
        registry.names(),
        vec![CHANNEL],
        "the adapter is registered under the delivery channel it serves"
    );
    assert!(
        registry.get(CHANNEL).is_some(),
        "the existing driver reaches the channel through the registry"
    );
    assert_eq!(
        registry.get(CHANNEL).expect("adapter").attempt_bound(),
        crate::delivery_ledger::DEFAULT_MAX_ATTEMPTS,
        "the channel leaves the attempt bound to the ledger's default"
    );

    // A record the policy refuses is reported, not registered.
    let mut refused = AdapterRegistry::new();
    db.set_setting("app", &settings_record("http://example.invalid/hooks/pi"))
        .expect("settings");
    assert!(register(&mut refused, &db, &secrets).is_err());
    assert!(refused.names().is_empty());
}

#[tokio::test]
async fn the_host_owned_registry_and_attempt_cycle_reach_the_registered_channel() {
    let dir = tempfile::tempdir().expect("tempdir");
    let fixture = fixture(200).await;
    {
        // The record and the token a configured Host would have, written
        // before the state is built so registration happens where the Host
        // does it: in state construction.
        let db = Database::open_in_dir(dir.path()).expect("database");
        db.set_setting("app", &settings_record(&fixture.endpoint))
            .expect("settings");
    }

    let state = Arc::new(tokio::sync::Mutex::new(
        crate::state::AppState::open(dir.path()).expect("app state"),
    ));
    {
        let st = state.lock().await;
        assert_eq!(
            st.messaging.names(),
            vec![CHANNEL],
            "state construction registered the configured channel"
        );
    }

    // Enqueue through the adapter hand-off, then run one attempt cycle the
    // way the Host's driver does.
    let id = {
        let st = state.lock().await;
        crate::messaging_adapter::enqueue_for(&st.db, &st.messaging, CHANNEL, summary().payload)
            .expect("enqueue")
            .id
    };
    let outcome = {
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            let st = state.blocking_lock();
            crate::messaging_adapter::attempt_one(&st.db, &st.messaging, "worker-a")
        })
        .await
        .expect("cycle task")
        .expect("cycle")
    };
    assert_eq!(
        outcome,
        crate::messaging_adapter::AttemptOutcome::Delivered { id: id.clone() },
        "the driver's cycle reached the webhook channel and the ledger recorded it"
    );

    let seen = fixture.requests();
    assert_eq!(seen.len(), 1, "the channel posted the one delivery");
    let body: serde_json::Value =
        serde_json::from_slice(&seen[0].body).expect("request body is JSON");
    assert_eq!(
        body,
        json!({
            "deliveryId": id.clone(),
            "channel": CHANNEL,
            "redelivery": false,
            "summary": summary().payload,
        }),
        "the request body is the expected JSON: the redacted summary plus the delivery metadata"
    );

    {
        let st = state.lock().await;
        let row = crate::delivery_ledger::get(&st.db, &id)
            .expect("get")
            .expect("row");
        assert_eq!(row.state, crate::delivery_ledger::DeliveryState::Delivered);
    }
    fixture.stop();
}

#[tokio::test]
async fn the_bearer_token_never_reaches_a_detail_a_debug_an_error_or_a_log_line() {
    const TOKEN: &str = "s3cret-token-value";

    // A real attempt carries the credential on the wire, and the failure detail
    // the ledger keeps must not echo it.
    let refusing = fixture(503).await;
    let adapter = Arc::new(adapter(&refusing.endpoint, Some(TOKEN), None));
    let rendered = format!("{:?}", deliver(&adapter, summary()).await);
    assert!(
        !rendered.contains(TOKEN),
        "a failure detail must not carry the credential: {rendered}"
    );
    refusing.stop();

    // A credential placed in the endpoint itself is a path a message could
    // echo, so the refusal of that endpoint must not name it. The bearer header
    // is left unset so the address is the only carrier, which is what makes the
    // assertion able to fail: a validator that echoed the address it was handed
    // would leak the credential.
    let endpoint_record: StoredConfig = serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": format!("https://user:{TOKEN}@example.invalid/hooks/pi"),
    }))
    .expect("record");
    let refusal = WebhookConfig::from_record(&endpoint_record, None, false)
        .err()
        .expect("userinfo is refused");
    assert!(
        !refusal.to_string().contains(TOKEN),
        "a refused endpoint must not echo the credential: {refusal}"
    );

    // The sensitive header value redacts itself in Debug, and so does a request
    // built from it.
    let header = bearer_value(TOKEN).expect("header");
    let debugged = format!("{header:?}");
    assert!(
        !debugged.contains(TOKEN) && debugged.contains("Sensitive"),
        "a sensitive header value redacts in Debug: {debugged}"
    );
    let endpoint = Url::parse("https://example.invalid/hooks/pi").expect("url");
    let request = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, header)
        .body("{}")
        .build()
        .expect("request");
    let debugged = format!("{request:?}");
    assert!(
        !debugged.contains(TOKEN),
        "a debugged request must not reveal the credential: {debugged}"
    );

    // A configuration error must not echo the credential either, and no line
    // logged while the configuration is built may carry it.
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("webhook.log");
    let target = log_path.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || std::fs::File::create(&target).expect("log file"))
        .finish();
    let record: StoredConfig = serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": "ws://example.invalid/hooks/pi",
    }))
    .expect("record");
    let error = tracing::subscriber::with_default(subscriber, || {
        WebhookConfig::from_record(&record, Some(TOKEN.to_string()), false)
            .map(|_| ())
            .expect_err("a non-HTTP scheme is refused")
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

#[tokio::test]
async fn the_channel_spends_its_ledger_bound_and_then_stops() {
    let (_dir, db, _secrets) = host_settings();
    let fixture = fixture(503).await;

    // The channel registered the way the Host does it, so its own attempt bound
    // is the delivery's budget.
    let record: StoredConfig = serde_json::from_value(json!({
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "endpoint": fixture.endpoint,
    }))
    .expect("record");
    let mut registry = AdapterRegistry::new();
    let mut adapter = WebhookAdapter::new()
        .configure(WebhookConfig::from_record(&record, None, true).expect("config"));
    adapter.connect().expect("connect");
    registry
        .register(CHANNEL, Box::new(adapter))
        .expect("register");

    let delivery =
        crate::messaging_adapter::enqueue_for(&db, &registry, CHANNEL, summary().payload)
            .expect("enqueue");
    let bound = crate::delivery_ledger::DEFAULT_MAX_ATTEMPTS;
    assert_eq!(
        delivery.max_attempts, bound,
        "the delivery carries the channel's ledger bound as its attempt budget"
    );

    let id = delivery.id.clone();
    let (outcomes, final_state) = tokio::task::spawn_blocking(move || {
        let mut outcomes = Vec::new();
        for _ in 0..bound {
            // Stand in for the backoff delay elapsing, as the ledger's own
            // tests do, so each attempt is due.
            db.conn()
                .execute(
                    "UPDATE delivery_ledger SET next_attempt_at = 0 WHERE id = ?1",
                    rusqlite::params![id],
                )
                .expect("open the backoff gate");
            outcomes.push(
                crate::messaging_adapter::attempt_one(&db, &registry, "worker-a").expect("cycle"),
            );
        }
        let state = crate::delivery_ledger::get(&db, &id)
            .expect("get")
            .expect("row")
            .state;
        (outcomes, state)
    })
    .await
    .expect("cycle task");

    assert_eq!(outcomes.len() as i64, bound);
    for (index, outcome) in outcomes.iter().enumerate() {
        if (index as i64) < bound - 1 {
            assert!(
                matches!(
                    outcome,
                    crate::messaging_adapter::AttemptOutcome::Retried { .. }
                ),
                "attempt {index} is retried under the bound: {outcome:?}"
            );
        } else {
            assert!(
                matches!(
                    outcome,
                    crate::messaging_adapter::AttemptOutcome::Failed { .. }
                ),
                "the attempt that reaches the bound ends terminally: {outcome:?}"
            );
        }
    }
    assert_eq!(
        final_state,
        crate::delivery_ledger::DeliveryState::Failed,
        "the delivery terminals at the bound and is never attempted again"
    );
    assert_eq!(
        fixture.requests().len() as i64,
        bound,
        "exactly the bound's worth of attempts reached the endpoint"
    );

    fixture.stop();
}

/// What an in-memory channel records while the seam test drives it: the real
/// [`OutboundAdapter`] contract with no transport behind it, shaped like the
/// fake adapter the contract's own tests use.
#[derive(Default)]
struct Recording {
    sent: Vec<OutboundMessage>,
}

struct RecordingAdapter {
    state: Arc<Mutex<Recording>>,
}

impl OutboundAdapter for RecordingAdapter {
    fn connect(&mut self) -> Result<()> {
        Ok(())
    }

    fn disconnect(&mut self) -> Result<()> {
        Ok(())
    }

    fn send(&self, message: &OutboundMessage) -> SendResult {
        self.state
            .lock()
            .expect("recording")
            .sent
            .push(message.clone());
        SendResult::Delivered
    }
}

#[test]
fn the_channel_seam_hands_the_summary_to_whatever_is_registered() {
    let (_dir, db, _secrets) = host_settings();
    let recorded = Arc::new(Mutex::new(Recording::default()));
    let mut registry = AdapterRegistry::new();
    registry
        .register(
            CHANNEL,
            Box::new(RecordingAdapter {
                state: recorded.clone(),
            }),
        )
        .expect("register");

    let delivery =
        crate::messaging_adapter::enqueue_for(&db, &registry, CHANNEL, summary().payload)
            .expect("enqueue");
    let outcome = crate::messaging_adapter::attempt_one(&db, &registry, "worker-a").expect("cycle");
    assert_eq!(
        outcome,
        crate::messaging_adapter::AttemptOutcome::Delivered {
            id: delivery.id.clone()
        }
    );

    let sent = recorded.lock().expect("recording").sent.clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].id, delivery.id);
    assert_eq!(sent[0].channel, CHANNEL);
    assert_eq!(sent[0].payload, summary().payload);
    assert!(!sent[0].redelivery);
}
