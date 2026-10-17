//! Shared outbound HTTP transport for the messaging channels (ADR 0205 D375
//! item 9, rollout R3).
//!
//! The webhook channel established the shape an outbound channel follows: one
//! synchronous `OutboundAdapter` that posts a single JSON request per attempt
//! from a worker thread, classifies the outcome for the delivery ledger, and
//! reads its endpoint from the shared `app` settings row and its credential from
//! the secret store.
//!
//! What one chat channel now shares with another lives here once: the request
//! worker and its adapter ([`HttpChannelAdapter`]), the status and transport
//! classification, the body-aware classification a channel whose API answers a
//! refusal with a body selects, the endpoint rule, the request-timeout and
//! bearer-header validation, the delivery envelope, and the loopback test
//! fixture.
//!
//! The webhook module predates this one and is already merged, so it still
//! carries its own copy of that shape rather than calling this one: its adapter,
//! worker, `post`, status and transport classification, envelope, endpoint rule,
//! request-timeout and bearer validation, stored-record reader, registration,
//! and loopback fixture are restated there. That duplication is left as it is in
//! this increment — folding the two modules together would be a transport
//! refactor inside a feature change — and nothing here alters the webhook's
//! behaviour: a status-bearing answer is classified the same way in both.
//!
//! # Direction: this transport is outbound only
//!
//! This module, and every channel built on it, sends only. Nothing here binds,
//! listens, accepts, or long-polls: the one socket a channel opens is a client
//! connection *to* the endpoint the user configured.
//!
//! The inbound command path is not part of this transport. It is delivered by
//! the messaging integration's driver in the agent host module, beside the turn
//! and approval operations it invokes, and it reaches the channel by an
//! outbound long poll of its own — an ordinary HTTPS request the Host
//! originates — so neither this transport nor that driver opens a listener, a
//! port, or an accepting socket. The chat-to-principal link, the command
//! mapping, the request-context mint, and the inbound replay guard all live on
//! that driver; none of them lives here, and there is still no second enqueue
//! path and no second registry.
//!
//! # The lock rule
//!
//! No channel holds the host state lock across a blocking send, on any path
//! including error and early returns. A channel therefore touches no guarded
//! Host state while an attempt is in flight: its endpoint, credential, and
//! timeout are resolved once, at registration, before any attempt runs, and the
//! attempt cycle releases the lock before it calls `send`. The worker thread
//! exists so the synchronous `send` never drives a runtime that the caller might
//! be holding — not so it can hold guarded state.
//!
//! # How one attempt is classified
//!
//! A channel selects one of two rules, both living here. Under the status rule,
//! a 2xx is the receiver's acceptance; 429 and 5xx are the receiver saying "not
//! now" and stay retryable; every other status is a refusal of this delivery
//! that no later attempt changes. Under the body rule — for a channel whose API
//! answers a refusal with HTTP 200 and a JSON body — a 2xx is an acceptance only
//! when its body says so, a non-2xx keeps the status rule, and a 2xx whose body
//! cannot be read is not an acceptance. A timeout, a connection that could not
//! be established, and a response body that could not be read stay retryable; a
//! response the client cannot accept ends the delivery terminally.
//! [`classify_transport`] records the one place where the client's public error
//! surface cannot separate two of those cases, and what the channel does about
//! it.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::header::{HeaderValue, CONTENT_TYPE};
use reqwest::{Client, StatusCode, Url};
use serde_json::Value;

use crate::messaging_adapter::{FailureKind, OutboundAdapter, OutboundMessage, SendResult};

/// How long one attempt may take when the record does not say.
pub(crate) const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// The accepted `requestTimeoutMs` range. A bound is the point of the setting,
/// so a value outside it is refused rather than clamped.
pub(crate) const MIN_REQUEST_TIMEOUT_MS: u64 = 250;
pub(crate) const MAX_REQUEST_TIMEOUT_MS: u64 = 60_000;
/// How long the worker has to establish a TCP/TLS connection. Shorter than the
/// whole-request timeout so a black-holed address fails early.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long `send` waits for the worker on top of the request timeout. The
/// request's own timeout should always fire first; this is the slack that keeps
/// a scheduling delay from being reported as a timeout.
const REPLY_GRACE: Duration = Duration::from_secs(2);
/// The most a failure detail may carry. The ledger keeps the detail as the
/// delivery's last error, so it stays one bounded, credential-free line.
pub(crate) const MAX_DETAIL_CHARS: usize = 200;

/// Builds one attempt's JSON body from the delivery summary.
///
/// A channel resolves everything the body depends on — its destination, the
/// delivery metadata — into this closure at configuration time, so the body is
/// built on the caller's thread and only the finished bytes cross to the worker.
pub(crate) type BodyBuilder = Box<dyn Fn(&OutboundMessage) -> Value + Send + Sync>;

/// Where a channel's answer carries the outcome.
///
/// Most channels signal a refusal with an HTTP status, and the status alone is
/// the answer. A channel whose API answers a refusal with HTTP 200 and a JSON
/// body of `{"ok":false,...}` needs the body read to know whether the delivery
/// was accepted: there the body is the answer, and the status only separates
/// "read the body" from the status-based transport cases.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutcomeSource {
    /// The HTTP status alone carries the outcome.
    Status,
    /// A 2xx response carries a JSON body whose `ok` field carries the outcome.
    Body,
}

/// A validated channel configuration: where a channel posts, what credential it
/// carries, how long it may take, how it turns a summary into a body, and where
/// its answer carries the outcome.
///
/// Deliberately not `Debug`: it holds the endpoint (which for a channel whose
/// credential lives in the URL path would carry it) and the credential header
/// value, and no path may print either.
pub(crate) struct ChannelConfig {
    endpoint: Url,
    /// `Some` only when a credential is configured. The value is marked
    /// sensitive so nothing that formats a request can reveal it.
    authorization: Option<HeaderValue>,
    request_timeout: Duration,
    body: BodyBuilder,
    outcome: OutcomeSource,
}

impl ChannelConfig {
    pub(crate) fn new(
        endpoint: Url,
        authorization: Option<HeaderValue>,
        request_timeout: Duration,
        body: BodyBuilder,
    ) -> Self {
        Self {
            endpoint,
            authorization,
            request_timeout,
            body,
            outcome: OutcomeSource::Status,
        }
    }

    /// Read the answer's outcome from the response body instead of the status.
    ///
    /// Selected by a channel whose API answers a refusal with HTTP 200 and a
    /// JSON body, so that the status rule alone would record a refusal as
    /// delivered.
    pub(crate) fn with_body_outcome(mut self) -> Self {
        self.outcome = OutcomeSource::Body;
        self
    }
}

/// One delivery summary handed to the worker.
///
/// The reply channel is per attempt, so a caller that has given up on a slow
/// request simply drops its end and the worker's send fails harmlessly.
struct Job {
    body: Vec<u8>,
    reply: Sender<SendResult>,
}

/// The running worker: the pipe to the thread that drives the requests.
struct Worker {
    jobs: Sender<Job>,
    handle: std::thread::JoinHandle<()>,
}

/// A channel that posts one JSON request per attempt to a configured endpoint.
///
/// It is built in two steps, exactly like the webhook channel, so the "not
/// configured" state is a real one rather than an unreachable branch: [`new`]
/// starts an adapter with no configuration, and [`configure`](Self::configure)
/// gives it the validated record [`connect`](OutboundAdapter::connect) accepts.
/// An adapter that was never configured refuses to connect and fails every send
/// retryably instead of posting nowhere.
///
/// [`new`]: HttpChannelAdapter::new
pub(crate) struct HttpChannelAdapter {
    /// The channel's own word for itself, used only to build failure details.
    label: &'static str,
    config: Option<ChannelConfig>,
    worker: Option<Worker>,
}

impl HttpChannelAdapter {
    pub(crate) fn new(label: &'static str) -> Self {
        Self {
            label,
            config: None,
            worker: None,
        }
    }

    pub(crate) fn configure(mut self, config: ChannelConfig) -> Self {
        self.config = Some(config);
        self
    }
}

impl OutboundAdapter for HttpChannelAdapter {
    /// Build the client and start the worker that will drive the attempts.
    ///
    /// The only work here is validation and one thread: no request is made, and
    /// no listener is opened. Connecting twice is a no-op rather than a second
    /// worker, so a repeated lifecycle pass cannot leak a thread.
    fn connect(&mut self) -> Result<()> {
        if self.worker.is_some() {
            return Ok(());
        }
        let Some(config) = self.config.as_ref() else {
            bail!("MESSAGING_CHANNEL_NOT_CONFIGURED: the channel is not configured");
        };
        let client = Client::builder()
            // A redirected POST would carry the credential to whatever host the
            // endpoint names next, so a redirect is answered here as a status
            // the classification can refuse.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(config.request_timeout)
            .build()
            .context("build the channel client")?;
        let endpoint = config.endpoint.clone();
        let authorization = config.authorization.clone();
        let outcome = config.outcome;
        let label = self.label;
        let (jobs, pending) = mpsc::channel::<Job>();
        let handle = std::thread::Builder::new()
            .name(format!("messaging-{label}"))
            .spawn(move || run_worker(pending, client, endpoint, authorization, outcome, label))
            .context("start the channel worker thread")?;
        self.worker = Some(Worker { jobs, handle });
        Ok(())
    }

    /// Stop the worker and wait for it. Safe on a never-connected adapter.
    ///
    /// Dropping the job pipe ends the worker's receive loop; the join then waits
    /// for at most the one request that was already in flight, which its own
    /// timeout bounds.
    fn disconnect(&mut self) -> Result<()> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        drop(worker.jobs);
        let _ = worker.handle.join();
        Ok(())
    }

    /// Post one delivery summary and classify the outcome.
    ///
    /// No retry, no sleep, no turn, and no guarded Host state touched: this
    /// returns the whole result of one attempt, and the ledger decides what it
    /// means.
    fn send(&self, message: &OutboundMessage) -> SendResult {
        let Some(worker) = self.worker.as_ref() else {
            return failed(
                FailureKind::Retryable,
                &format!("the {} adapter is not connected", self.label),
            );
        };
        let Some(config) = self.config.as_ref() else {
            return failed(
                FailureKind::Retryable,
                &format!("the {} adapter is not configured", self.label),
            );
        };
        let body = match serde_json::to_vec(&(config.body)(message)) {
            Ok(body) => body,
            Err(error) => {
                // Terminal: the same summary would fail to serialize on every
                // later attempt, so the ledger should stop spending the budget.
                return failed(
                    FailureKind::Terminal,
                    &format!("the delivery summary could not be serialized: {error}"),
                );
            }
        };
        let (reply, answer) = mpsc::channel();
        if worker.jobs.send(Job { body, reply }).is_err() {
            return failed(
                FailureKind::Retryable,
                &format!("the {} worker stopped before the attempt", self.label),
            );
        }
        let budget = config.request_timeout + REPLY_GRACE;
        match answer.recv_timeout(budget) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => failed(
                FailureKind::Retryable,
                &format!(
                    "the {} attempt did not answer within {}s",
                    self.label,
                    budget.as_secs()
                ),
            ),
            Err(RecvTimeoutError::Disconnected) => failed(
                FailureKind::Retryable,
                &format!("the {} worker stopped before answering", self.label),
            ),
        }
    }
}

/// The worker loop: own the runtime the request needs, answer one job at a time.
///
/// The runtime is built here rather than in `connect` so that a runtime that
/// cannot start is reported per attempt instead of being dropped inside the
/// caller's runtime, and so the only request ever driven on it is this
/// channel's. A runtime that failed to build answers every job retryably rather
/// than dropping it, so a caller is never left waiting on a reply that will not
/// come.
fn run_worker(
    pending: Receiver<Job>,
    client: Client,
    endpoint: Url,
    authorization: Option<HeaderValue>,
    outcome: OutcomeSource,
    label: &'static str,
) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let Ok(runtime) = runtime else {
        while let Ok(job) = pending.recv() {
            let _ = job.reply.send(failed(
                FailureKind::Retryable,
                &format!("the {label} delivery runtime is unavailable"),
            ));
        }
        return;
    };
    while let Ok(job) = pending.recv() {
        let result = runtime.block_on(post(
            &client,
            &endpoint,
            authorization.as_ref(),
            job.body,
            outcome,
            label,
        ));
        let _ = job.reply.send(result);
    }
}

/// One POST, classified. The one place a status, an answer body, or a transport
/// failure becomes a [`SendResult`].
async fn post(
    client: &Client,
    endpoint: &Url,
    authorization: Option<&HeaderValue>,
    body: Vec<u8>,
    outcome: OutcomeSource,
    label: &str,
) -> SendResult {
    let mut request = client
        .post(endpoint.clone())
        .header(CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(value) = authorization {
        request = request.header(reqwest::header::AUTHORIZATION, value.clone());
    }
    match request.send().await {
        Ok(response) => match outcome {
            OutcomeSource::Status => classify_status(response.status(), label),
            OutcomeSource::Body => classify_answer(response, label).await,
        },
        Err(error) => classify_transport(&error, label),
    }
}

/// What an answer whose body carries the outcome means for the ledger.
///
/// The status still decides the case where the API refuses a delivery with a
/// status: a non-2xx is classified exactly as the status rule would. A 2xx is
/// an acceptance only when its body says so; the body is read for that, and a
/// body that could not be read at all is not an acceptance either — the channel
/// cannot see one, so the attempt is failed retryably, the same posture the
/// transport rule takes for an answer whose body could not be read.
async fn classify_answer(response: reqwest::Response, label: &str) -> SendResult {
    if !response.status().is_success() {
        return classify_status(response.status(), label);
    }
    match response.text().await {
        Ok(body) => classify_body(&body, label),
        Err(_) => failed(
            FailureKind::Retryable,
            &format!("the {label} response body could not be read"),
        ),
    }
}

/// The API's own error names that mean "not now" rather than "never": a rate
/// limit or a transient server fault. Any other refusal — authentication,
/// channel, membership, or payload — is a condition a later attempt cannot
/// clear, so it is terminal.
///
/// `fatal_error` is deliberately here rather than terminal: it names a
/// server-side fault on the platform's side, not a fault in this request, so a
/// later attempt may not meet it. The set is a fixed allowlist, so a name it
/// does not carry fails closed to terminal.
const RETRYABLE_REFUSALS: &[&str] = &[
    "ratelimited",
    "rate_limited",
    "internal_error",
    "service_unavailable",
    "fatal_error",
];

/// The word carried when a refusal names no error, so the detail is never blank.
const UNNAMED_REFUSAL: &str = "an unspecified error";

/// What a JSON answer body means when the body, not the status, carries the
/// outcome.
///
/// The acceptance flag decides: `true` is a delivery, `false` is a refusal. A
/// refusal is terminal unless its error name is one a later attempt can clear
/// ([`RETRYABLE_REFUSALS`]), in which case it stays retryable. The error name is
/// carried into the detail because it is the only diagnostic the operator gets.
/// A body that is not JSON, or that carries no acceptance flag, is not an
/// acceptance: the channel cannot see one, so the attempt is failed retryably
/// rather than recorded delivered.
pub(crate) fn classify_body(body: &str, label: &str) -> SendResult {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return failed(
            FailureKind::Retryable,
            &format!("the {label} response body could not be read"),
        );
    };
    match value.get("ok").and_then(Value::as_bool) {
        Some(true) => SendResult::Delivered,
        Some(false) => {
            let error = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or(UNNAMED_REFUSAL);
            let kind = if RETRYABLE_REFUSALS.contains(&error) {
                FailureKind::Retryable
            } else {
                FailureKind::Terminal
            };
            failed(
                kind,
                &format!("the {label} endpoint refused the delivery: {error}"),
            )
        }
        None => failed(
            FailureKind::Retryable,
            &format!("the {label} response body could not be read"),
        ),
    }
}

/// What a status means for the ledger.
///
/// A 2xx is the receiver's acceptance. 429 and 5xx are the receiver saying "not
/// now", which is retryable by definition. Everything else — the other 4xx, a
/// 3xx the client refused to follow, a 1xx — is a refusal of this delivery that
/// no later attempt changes.
pub(crate) fn classify_status(status: StatusCode, label: &str) -> SendResult {
    if status.is_success() {
        return SendResult::Delivered;
    }
    let kind = if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        FailureKind::Retryable
    } else {
        FailureKind::Terminal
    };
    failed(
        kind,
        &format!("the {label} endpoint answered HTTP {status}"),
    )
}

/// What a transport failure means for the ledger.
///
/// A timeout, a connection that could not be established, and a body that could
/// not be read are conditions the next attempt may not meet, so they stay
/// retryable. Everything else — a response this client could not accept, a
/// redirect it refused to follow, a request it could not build — is terminal:
/// the endpoint will answer the same way again.
///
/// Measured against the client this Host has (reqwest 0.12, whose public error
/// surface exposes `is_timeout`, `is_connect`, `is_body`, `is_request`,
/// `is_decode`, `is_redirect`, and `is_builder`), a response the client cannot
/// parse and a connection closed before the response completes are *the same
/// error*: `is_request` with no connection marker, no timeout, and nothing in
/// the source chain. The two cannot be told apart without depending on the
/// transport crates directly, which this module must not do, so both land in
/// the terminal half and the detail names the ambiguity rather than guessing
/// between them.
pub(crate) fn classify_transport(error: &reqwest::Error, label: &str) -> SendResult {
    if error.is_timeout() {
        failed(
            FailureKind::Retryable,
            &format!("the {label} request timed out"),
        )
    } else if error.is_connect() {
        failed(
            FailureKind::Retryable,
            &format!("the connection to the {label} endpoint failed"),
        )
    } else if error.is_body() {
        failed(
            FailureKind::Retryable,
            &format!("the {label} response body could not be read"),
        )
    } else {
        failed(
            FailureKind::Terminal,
            &format!(
                "the {label} endpoint sent a malformed response or closed the connection before answering"
            ),
        )
    }
}

/// The JSON body one delivery carries, before a channel re-shapes it.
///
/// The ledger's delivery id and channel and the redelivery flag are what a
/// receiver needs to recognise a duplicate, and `summary` is the caller's
/// already-redacted payload forwarded verbatim. Nothing is added, read, or
/// rewritten on the way through, and this is the same envelope the webhook
/// channel posts — so every channel carries the same redacted summary.
pub(crate) fn envelope(message: &OutboundMessage) -> Value {
    serde_json::json!({
        "deliveryId": message.id,
        "channel": message.channel,
        "redelivery": message.redelivery,
        "summary": message.payload,
    })
}

/// The redacted summary rendered as the text a chat message carries.
///
/// The platform message body carries text, so the envelope is rendered to its
/// compact JSON string: the same structure, the same metadata, nothing added.
pub(crate) fn envelope_text(message: &OutboundMessage) -> String {
    envelope(message).to_string()
}

pub(crate) fn failed(kind: FailureKind, detail: &str) -> SendResult {
    SendResult::Failed {
        kind,
        detail: bounded(detail),
    }
}

/// Cap a detail at [`MAX_DETAIL_CHARS`], counted in characters so a multi-byte
/// summary id can never be cut mid-character.
pub(crate) fn bounded(detail: &str) -> String {
    if detail.chars().count() <= MAX_DETAIL_CHARS {
        return detail.to_string();
    }
    let mut text: String = detail.chars().take(MAX_DETAIL_CHARS).collect();
    text.push_str("...");
    text
}

/// Parse a channel's `requestTimeoutMs` against the shared accepted range.
pub(crate) fn request_timeout(ms: Option<u64>, code: &str) -> Result<Duration> {
    let Some(ms) = ms else {
        return Ok(DEFAULT_REQUEST_TIMEOUT);
    };
    if !(MIN_REQUEST_TIMEOUT_MS..=MAX_REQUEST_TIMEOUT_MS).contains(&ms) {
        bail!(
            "{code}: requestTimeoutMs must be between {MIN_REQUEST_TIMEOUT_MS} and {MAX_REQUEST_TIMEOUT_MS}"
        );
    }
    Ok(Duration::from_millis(ms))
}

/// The `Authorization` header value for a configured credential, under the
/// scheme the platform's API specifies.
///
/// `credential` names the credential in a refusal, so a channel whose token is
/// called something else (an access token) reports it honestly. The value is
/// marked sensitive so nothing that formats a request can reveal it, and a
/// blank credential is refused rather than sent as an empty header.
pub(crate) fn authorization_header(
    scheme: &str,
    token: &str,
    code: &str,
    credential: &str,
) -> Result<HeaderValue> {
    let token = token.trim();
    if token.is_empty() {
        bail!("{code}: the configured {credential} is empty");
    }
    let mut value = HeaderValue::from_str(&format!("{scheme} {token}"))
        .with_context(|| format!("{code}: the {credential} is not a valid header value"))?;
    // Keeps the value out of every `{:?}` that could ever reach a log.
    value.set_sensitive(true);
    Ok(value)
}

/// The `Authorization` header value for a configured bot token, as `Bearer`.
pub(crate) fn bearer_header(token: &str, code: &str) -> Result<HeaderValue> {
    authorization_header("Bearer", token, code, "bot token")
}

/// Validate a configured endpoint and return the address to post to.
///
/// HTTPS is required; a plaintext `http` endpoint is accepted only for a
/// loopback, `.local`, or private LAN host while the relaxed network policy is
/// in force — the rule the config-sync transport and the webhook channel both
/// apply, reusing the shared [`is_lan_http_host`](crate::config_sync::transport::is_lan_http_host)
/// helper rather than restating it. A redacted summary still carries ids and
/// bounded text, so a public plaintext hop is refused outright in both modes.
/// Userinfo is refused because it would be a credential in the URL, and the
/// query and fragment are dropped so a receiver's own query string can never
/// smuggle a token into a detail or a log line.
pub(crate) fn validate_https_endpoint(
    raw: &str,
    allow_insecure_http: bool,
    code: &str,
) -> Result<Url> {
    let mut url = Url::parse(raw.trim())
        .with_context(|| format!("{code}: the configured endpoint is not a URL"))?;
    if !matches!(url.scheme(), "https" | "http") {
        bail!("{code}: the endpoint must use HTTPS");
    }
    if url.host_str().is_none() {
        bail!("{code}: the endpoint must name a host");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("{code}: the endpoint must not contain userinfo");
    }
    if url.scheme() == "http" {
        if !allow_insecure_http {
            bail!("{code}: plaintext HTTP requires the relaxed network policy");
        }
        if !crate::config_sync::transport::is_lan_http_host(url.host_str().unwrap_or_default()) {
            bail!(
                "{code}: plaintext HTTP is limited to localhost, .local, or private LAN addresses"
            );
        }
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message() -> OutboundMessage {
        OutboundMessage {
            id: "delivery-1".into(),
            channel: "channel".into(),
            payload: json!({ "kind": "turn.completed", "turnId": "turn-1" }),
            redelivery: false,
        }
    }

    #[test]
    fn the_envelope_carries_the_redacted_summary_and_the_correlation_fields() {
        assert_eq!(
            envelope(&message()),
            json!({
                "deliveryId": "delivery-1",
                "channel": "channel",
                "redelivery": false,
                "summary": { "kind": "turn.completed", "turnId": "turn-1" },
            })
        );
        assert_eq!(
            envelope_text(&message()),
            r#"{"channel":"channel","deliveryId":"delivery-1","redelivery":false,"summary":{"kind":"turn.completed","turnId":"turn-1"}}"#
        );
    }

    #[test]
    fn the_status_classification_keeps_throttles_and_server_errors_retryable() {
        assert_eq!(
            classify_status(StatusCode::OK, "chat"),
            SendResult::Delivered
        );
        assert_eq!(
            classify_status(StatusCode::NO_CONTENT, "chat"),
            SendResult::Delivered
        );
        match classify_status(StatusCode::TOO_MANY_REQUESTS, "chat") {
            SendResult::Failed { kind, detail } => {
                assert_eq!(kind, FailureKind::Retryable);
                assert!(detail.contains("429"), "the status is named: {detail}");
            }
            other => panic!("429 must be retryable: {other:?}"),
        }
        match classify_status(StatusCode::SERVICE_UNAVAILABLE, "chat") {
            SendResult::Failed { kind, .. } => assert_eq!(kind, FailureKind::Retryable),
            other => panic!("5xx must be retryable: {other:?}"),
        }
        match classify_status(StatusCode::BAD_REQUEST, "chat") {
            SendResult::Failed { kind, .. } => assert_eq!(kind, FailureKind::Terminal),
            other => panic!("4xx must be terminal: {other:?}"),
        }
    }

    #[test]
    fn a_detail_is_bounded_by_characters_not_bytes() {
        let long: String = "é".repeat(MAX_DETAIL_CHARS + 50);
        let capped = bounded(&long);
        assert_eq!(capped.chars().count(), MAX_DETAIL_CHARS + 3);
        assert!(capped.ends_with("..."));
        assert_eq!(bounded("short"), "short");
    }

    #[test]
    fn the_endpoint_rule_refuses_a_public_plaintext_hop_and_any_userinfo() {
        assert!(validate_https_endpoint("https://example.invalid/bot", false, "T").is_ok());
        assert!(
            validate_https_endpoint("http://example.invalid/bot", true, "T").is_err(),
            "a public plaintext hop is refused in every mode, even relaxed"
        );
        assert!(validate_https_endpoint("http://127.0.0.1:9000/bot", true, "T").is_ok());
        assert!(
            validate_https_endpoint("http://127.0.0.1:9000/bot", false, "T").is_err(),
            "plaintext needs the relaxed policy even on loopback"
        );
        assert!(
            validate_https_endpoint("https://user:pass@example.invalid/bot", false, "T").is_err()
        );
        assert!(validate_https_endpoint("ws://example.invalid/bot", false, "T").is_err());
        let url = validate_https_endpoint("https://example.invalid/bot?x=1#f", false, "T").unwrap();
        assert_eq!(url.query(), None);
        assert_eq!(url.fragment(), None);
    }

    #[test]
    fn a_bearer_header_is_sensitive_and_an_empty_token_is_refused() {
        let header = bearer_header("s3cret", "T").unwrap();
        assert!(format!("{header:?}").contains("Sensitive"));
        assert!(!format!("{header:?}").contains("s3cret"));
        assert!(bearer_header("   ", "T").is_err());
    }

    #[test]
    fn the_request_timeout_is_bounded_by_the_shared_range() {
        assert_eq!(request_timeout(None, "T").unwrap(), DEFAULT_REQUEST_TIMEOUT);
        assert!(request_timeout(Some(MIN_REQUEST_TIMEOUT_MS), "T").is_ok());
        assert!(request_timeout(Some(MAX_REQUEST_TIMEOUT_MS), "T").is_ok());
        assert!(request_timeout(Some(MIN_REQUEST_TIMEOUT_MS - 1), "T").is_err());
        assert!(request_timeout(Some(MAX_REQUEST_TIMEOUT_MS + 1), "T").is_err());
    }

    #[test]
    fn an_unconfigured_channel_refuses_to_connect_and_never_sends_anywhere() {
        let mut adapter = HttpChannelAdapter::new("chat");
        let error = adapter.connect().expect_err("connect must refuse");
        assert!(
            error
                .to_string()
                .contains("MESSAGING_CHANNEL_NOT_CONFIGURED"),
            "the refusal names the configuration: {error}"
        );
        assert_eq!(
            adapter.send(&message()),
            SendResult::Failed {
                kind: FailureKind::Retryable,
                detail: "the chat adapter is not connected".into()
            },
            "a channel that was never connected fails the attempt instead of inventing an acceptance"
        );
        adapter
            .disconnect()
            .expect("disconnect is safe when unconnected");
    }
}

#[cfg(test)]
pub(crate) mod fixture;
