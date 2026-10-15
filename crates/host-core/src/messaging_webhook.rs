//! The outbound webhook channel (ADR 0205 D375 item 9, rollout R3, step 5).
//!
//! This is the first concrete channel behind the already-merged
//! [`OutboundAdapter`] contract: it takes the redacted summary the Host hands
//! it, posts one JSON request to the endpoint the user configured, and
//! classifies the outcome for the delivery ledger. The direction is outbound
//! only. The channel never binds, listens, accepts, or long-polls anything: the
//! one socket in this module belongs to a client connection *to* the configured
//! endpoint, and the acceptance scenario's precondition — no inbound port is
//! open on the Host machine — stays true.
//!
//! # Why the attempt runs on its own thread
//!
//! [`OutboundAdapter::send`] is synchronous by contract and the only HTTP client
//! the Host has (reqwest, already a dependency) is asynchronous, so one of the
//! two has to give. This adapter resolves it on the delivery's own thread:
//! [`WebhookAdapter::connect`] starts one worker thread that owns a small
//! current-thread Tokio runtime, `send` posts the request to that worker and
//! waits for the classified result, and the request itself is driven on the
//! worker — never on the caller's runtime.
//!
//! The alternatives are all worse on this Host:
//!
//! * Driving the request with `Runtime::block_on` or `Handle::block_on` from
//!   `send` panics whenever the caller is a task, because Tokio refuses to start
//!   a runtime inside one. The delivery driver is exactly such a caller.
//! * `tokio::task::block_in_place` panics on a current-thread runtime — which is
//!   what `#[tokio::test]` builds — so the one mechanism that would let the
//!   caller's runtime keep working is the one the adapter's own tests cannot
//!   use.
//! * reqwest's `blocking` feature would add a capability to the dependency for
//!   nothing the worker thread does not already give. Measured against the
//!   vendored manifest, it resolves only `futures-channel` and `futures-util`
//!   (both already locked at 0.3.34) plus `tokio/sync`, so `Cargo.lock` would
//!   gain no package — but it would hide a second Tokio runtime and its own
//!   background thread behind a synchronous API the ledger calls, and it would
//!   make the request's timeout the only thing the adapter controls. The
//!   worker thread keeps that control explicit.
//!
//! The cost of the choice is that `send` blocks its caller, but the Host's
//! attempt cycle releases the host state lock before the call, so the wait does
//! not hold guarded Host state and cannot delay an unrelated turn. Both the
//! connect timeout and the whole-request timeout are therefore set, `send`
//! waits a little past the request timeout and no longer, and an unanswered
//! attempt is failed retryably. If the bound expires before the worker answers,
//! the worker may still be posting: the request carries `deliveryId` and
//! `redelivery` for exactly that reason, which is the same at-least-once
//! ambiguity the ledger's own crash reclaim already carries.
//!
//! The adapter never retries, never sleeps, and never blocks a turn: one POST
//! per attempt, classified, and nothing else. Retry, backoff, the 60s lease, and
//! the terminal `failed` state all stay the ledger's.
//!
//! # How one attempt is classified
//!
//! A 2xx is the receiver's acceptance; 429 and 5xx are the receiver saying "not
//! now" and stay retryable; every other status — the other 4xx, and a 3xx the
//! client refuses to follow because a redirected POST would carry the bearer
//! token somewhere else — refuses this delivery for good. A timeout, a
//! connection that could not be established, and a response body that could not
//! be read stay retryable; a response the client cannot accept ends the delivery
//! terminally. [`classify_transport`] records the one place where the client's
//! public error surface cannot separate two of those cases, and what the adapter
//! does about it.
//!
//! # Configuration
//!
//! There is no migration and no schema change: the endpoint record is read from
//! the same key/value settings row every other host feature reads
//! (`Database::get_setting("app")`), under a `messagingWebhook` section. That is
//! the mechanism `networkPolicy` and the rest of the app settings already use,
//! so the settings write path that lands with the remaining milestone steps can
//! carry the section through the existing `settings.set` verb with no new host
//! verb and no new namespace. The bearer token is read from the secret store
//! under `secret:messaging-webhook:bearer-token`, the shape config sync already
//! uses for its own credential (`secret:config-sync:webdav-password`).
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-webhook",
//!   "version": 1,
//!   "endpoint": "https://example.invalid/hooks/pi",
//!   "requestTimeoutMs": 10000
//! }
//! ```
//!
//! `format` and `version` follow the config-sync record so a record written by a
//! later build is refused instead of half-read. `requestTimeoutMs` is optional
//! and defaults to [`DEFAULT_REQUEST_TIMEOUT`]. An absent or null section
//! registers nothing at all, which is the documented behaviour: the Host runs
//! the same whether the adapter is configured or not.
//!
//! Authentication is an optional bearer token and nothing more. No signing
//! scheme is defined by any document for this channel, and inventing a wire
//! contract no document specifies would be worse than leaving it out; a channel
//! that needs one lands with its own decision.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::Database;
use crate::messaging_adapter::{
    AdapterRegistry, FailureKind, OutboundAdapter, OutboundMessage, SendResult,
};
use crate::secrets::SecretStore;

/// The delivery channel this adapter serves and the name it registers under.
///
/// The registry's name *is* the ledger's channel, so the Host wiring that
/// redacts an event and calls `messaging.enqueue` must enqueue to this value;
/// anything else is refused before it is persisted.
pub(crate) const CHANNEL: &str = "webhook";

/// The settings section the endpoint record lives in, inside the existing
/// `app` settings row.
const SETTINGS_SECTION: &str = "messagingWebhook";
/// The record's self-identifying format, beside config sync's own.
const FORMAT: &str = "pi-desktop-messaging-webhook";
const FORMAT_VERSION: u32 = 1;
/// Where the optional bearer token lives in the secret store.
const BEARER_TOKEN_SECRET_REF: &str = "secret:messaging-webhook:bearer-token";

/// How long one attempt may take when the record does not say.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the accepted `requestTimeoutMs` range is. A bound is the point of
/// the setting, so a value outside it is refused rather than clamped.
const MIN_REQUEST_TIMEOUT_MS: u64 = 250;
const MAX_REQUEST_TIMEOUT_MS: u64 = 60_000;
/// How long the worker has to establish a TCP/TLS connection. Shorter than the
/// whole-request timeout so a black-holed address fails early.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// How long [`OutboundAdapter::send`] waits for the worker on top of the
/// request timeout. The request's own timeout should always fire first; this is
/// the slack that keeps a scheduling delay from being reported as a timeout.
const REPLY_GRACE: Duration = Duration::from_secs(2);
/// The most a failure detail may carry. The ledger keeps the detail as the
/// delivery's last error, so it stays one bounded, credential-free line.
const MAX_DETAIL_CHARS: usize = 200;

/// The stored webhook record, exactly as the `messagingWebhook` settings
/// section carries it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    format: String,
    version: u32,
    endpoint: String,
    #[serde(default)]
    request_timeout_ms: Option<u64>,
}

/// A validated configuration. Deliberately not `Debug`: it holds the bearer
/// token's header value, and no path may print it.
struct WebhookConfig {
    endpoint: Url,
    /// `Some` only when a token is configured. The value is marked sensitive so
    /// nothing that formats a request can reveal it.
    authorization: Option<HeaderValue>,
    request_timeout: Duration,
}

impl WebhookConfig {
    /// Validate a stored record into a usable configuration.
    ///
    /// `allow_insecure_http` is the network policy's answer, carried as a
    /// parameter exactly as config-sync's `WebDavConfig` carries it, so the
    /// plaintext rule is decided by the caller and testable without flipping the
    /// process-wide policy.
    fn from_record(
        record: &StoredConfig,
        token: Option<String>,
        allow_insecure_http: bool,
    ) -> Result<Self> {
        if record.format != FORMAT {
            bail!(
                "MESSAGING_WEBHOOK_INVALID: unsupported webhook settings record '{}'",
                record.format
            );
        }
        if record.version != FORMAT_VERSION {
            bail!(
                "MESSAGING_WEBHOOK_UNSUPPORTED: webhook settings version {} is not supported",
                record.version
            );
        }
        Ok(Self {
            endpoint: validate_endpoint(&record.endpoint, allow_insecure_http)?,
            authorization: match token {
                Some(token) => Some(bearer_value(&token)?),
                None => None,
            },
            request_timeout: request_timeout(record)?,
        })
    }
}

fn request_timeout(record: &StoredConfig) -> Result<Duration> {
    let Some(ms) = record.request_timeout_ms else {
        return Ok(DEFAULT_REQUEST_TIMEOUT);
    };
    if !(MIN_REQUEST_TIMEOUT_MS..=MAX_REQUEST_TIMEOUT_MS).contains(&ms) {
        bail!(
            "MESSAGING_WEBHOOK_INVALID: requestTimeoutMs must be between \
             {MIN_REQUEST_TIMEOUT_MS} and {MAX_REQUEST_TIMEOUT_MS}"
        );
    }
    Ok(Duration::from_millis(ms))
}

/// The `Authorization` header value for a configured token.
fn bearer_value(token: &str) -> Result<HeaderValue> {
    let token = token.trim();
    if token.is_empty() {
        bail!("MESSAGING_WEBHOOK_INVALID: the configured bearer token is empty");
    }
    let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
        .context("MESSAGING_WEBHOOK_INVALID: the bearer token is not a valid header value")?;
    // Keeps the value out of every `{:?}` that could ever reach a log.
    value.set_sensitive(true);
    Ok(value)
}

/// Validate the configured sink and return the address to post to.
///
/// HTTPS is required; a plaintext `http` endpoint is accepted only for a
/// loopback, `.local`, or private LAN host while the relaxed network policy is
/// in force — the rule the config-sync transport already applies, reused rather
/// than restated. A redacted summary still carries ids and bounded text, so a
/// public plaintext hop is refused outright in both modes. Userinfo is refused
/// because it would be a credential in the URL, and the query and fragment are
/// dropped so a receiver's own query string can never smuggle a token into a
/// detail or a log line.
fn validate_endpoint(raw: &str, allow_insecure_http: bool) -> Result<Url> {
    let mut url = Url::parse(raw.trim())
        .context("MESSAGING_WEBHOOK_INVALID: the configured endpoint is not a URL")?;
    if !matches!(url.scheme(), "https" | "http") {
        bail!("MESSAGING_WEBHOOK_INVALID: the endpoint must use HTTPS");
    }
    if url.host_str().is_none() {
        bail!("MESSAGING_WEBHOOK_INVALID: the endpoint must name a host");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("MESSAGING_WEBHOOK_INVALID: the endpoint must not contain userinfo");
    }
    if url.scheme() == "http" {
        if !allow_insecure_http {
            bail!("MESSAGING_WEBHOOK_INVALID: plaintext HTTP requires the relaxed network policy");
        }
        if !crate::config_sync::transport::is_lan_http_host(url.host_str().unwrap_or_default()) {
            bail!(
                "MESSAGING_WEBHOOK_INVALID: plaintext HTTP is limited to localhost, .local, or \
                 private LAN addresses"
            );
        }
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
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

/// The outbound webhook channel.
///
/// It is built in two steps so the "not configured" state is a real one rather
/// than an unreachable branch: [`WebhookAdapter::new`] starts an adapter with no
/// endpoint, and [`WebhookAdapter::configure`] gives it the validated record
/// `connect` accepts. An adapter that was never configured can be registered —
/// the registry's rules are its own — but it refuses to connect and fails every
/// send retryably instead of posting nowhere.
pub(crate) struct WebhookAdapter {
    config: Option<WebhookConfig>,
    worker: Option<Worker>,
}

impl WebhookAdapter {
    fn new() -> Self {
        Self {
            config: None,
            worker: None,
        }
    }

    fn configure(mut self, config: WebhookConfig) -> Self {
        self.config = Some(config);
        self
    }
}

impl OutboundAdapter for WebhookAdapter {
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
            bail!("MESSAGING_WEBHOOK_NOT_CONFIGURED: no webhook endpoint is configured");
        };
        let client = Client::builder()
            // A redirected POST would carry the bearer token to whatever host
            // the endpoint names next, so a redirect is answered here as a
            // status the classification can refuse.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(config.request_timeout)
            .build()
            .context("build the webhook client")?;
        let endpoint = config.endpoint.clone();
        let authorization = config.authorization.clone();
        let (jobs, pending) = mpsc::channel::<Job>();
        let handle = std::thread::Builder::new()
            .name("messaging-webhook".into())
            .spawn(move || run_worker(pending, client, endpoint, authorization))
            .context("start the webhook worker thread")?;
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
    /// No retry, no sleep, no turn: this returns the whole result of one
    /// attempt, and the ledger decides what it means.
    fn send(&self, message: &OutboundMessage) -> SendResult {
        let Some(worker) = self.worker.as_ref() else {
            return failed(
                FailureKind::Retryable,
                "the webhook adapter is not connected",
            );
        };
        let body = match serde_json::to_vec(&envelope(message)) {
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
                "the webhook worker stopped before the attempt",
            );
        }
        let budget = self
            .config
            .as_ref()
            .map_or(DEFAULT_REQUEST_TIMEOUT, |config| config.request_timeout)
            + REPLY_GRACE;
        match answer.recv_timeout(budget) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => failed(
                FailureKind::Retryable,
                &format!(
                    "the webhook attempt did not answer within {}s",
                    budget.as_secs()
                ),
            ),
            Err(RecvTimeoutError::Disconnected) => failed(
                FailureKind::Retryable,
                "the webhook worker stopped before answering",
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
) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let Ok(runtime) = runtime else {
        while let Ok(job) = pending.recv() {
            let _ = job.reply.send(failed(
                FailureKind::Retryable,
                "the webhook delivery runtime is unavailable",
            ));
        }
        return;
    };
    while let Ok(job) = pending.recv() {
        let result = runtime.block_on(post(&client, &endpoint, authorization.as_ref(), job.body));
        let _ = job.reply.send(result);
    }
}

/// One POST, classified. The one place a status or a transport failure becomes
/// a [`SendResult`].
async fn post(
    client: &Client,
    endpoint: &Url,
    authorization: Option<&HeaderValue>,
    body: Vec<u8>,
) -> SendResult {
    let mut request = client
        .post(endpoint.clone())
        .header(CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(value) = authorization {
        request = request.header(AUTHORIZATION, value.clone());
    }
    match request.send().await {
        Ok(response) => classify_status(response.status()),
        Err(error) => failed(classify_transport(&error), &transport_detail(&error)),
    }
}

/// What a status means for the ledger.
///
/// A 2xx is the receiver's acceptance. 429 and 5xx are the receiver saying "not
/// now", which is retryable by definition. Everything else — the other 4xx, a
/// 3xx the client refused to follow, a 1xx — is a refusal of this delivery that
/// no later attempt changes.
fn classify_status(status: StatusCode) -> SendResult {
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
        &format!("the webhook endpoint answered HTTP {status}"),
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
/// transport crates directly, which this adapter must not do, so both land in
/// the terminal half — the mapping this milestone asks for — and the detail
/// names the ambiguity rather than guessing between them.
fn classify_transport(error: &reqwest::Error) -> FailureKind {
    if error.is_timeout() || error.is_connect() || error.is_body() {
        FailureKind::Retryable
    } else {
        FailureKind::Terminal
    }
}

/// A short, credential-free reason for a transport failure.
///
/// Built from this module's own vocabulary rather than from the client's message
/// so that neither the address nor any header value can reach the ledger's last
/// error, and so the detail stays one bounded line.
fn transport_detail(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "the webhook request timed out".to_string()
    } else if error.is_connect() {
        "the connection to the webhook endpoint failed".to_string()
    } else if error.is_body() {
        "the webhook response body could not be read".to_string()
    } else {
        "the webhook endpoint sent a malformed response or closed the connection before answering"
            .to_string()
    }
}

/// The JSON body of one delivery.
///
/// The ledger's delivery id and channel and the redelivery flag are what a
/// receiver needs to recognise a duplicate, and `summary` is the caller's
/// already-redacted payload forwarded verbatim. Nothing is added, read, or
/// rewritten on the way through.
fn envelope(message: &OutboundMessage) -> serde_json::Value {
    json!({
        "deliveryId": message.id,
        "channel": message.channel,
        "redelivery": message.redelivery,
        "summary": message.payload,
    })
}

fn failed(kind: FailureKind, detail: &str) -> SendResult {
    SendResult::Failed {
        kind,
        detail: bounded(detail),
    }
}

/// Cap a detail at [`MAX_DETAIL_CHARS`], counted in characters so a multi-byte
/// summary id can never be cut mid-character.
fn bounded(detail: &str) -> String {
    if detail.chars().count() <= MAX_DETAIL_CHARS {
        return detail.to_string();
    }
    let mut text: String = detail.chars().take(MAX_DETAIL_CHARS).collect();
    text.push_str("...");
    text
}

/// The stored record, if the Host has one.
fn stored_record(db: &Database) -> Result<Option<StoredConfig>> {
    let Some(settings) = db.get_setting("app")? else {
        return Ok(None);
    };
    let Some(section) = settings.get(SETTINGS_SECTION) else {
        return Ok(None);
    };
    if section.is_null() {
        return Ok(None);
    }
    let record: StoredConfig = serde_json::from_value(section.clone())
        .context("MESSAGING_WEBHOOK_INVALID: the webhook settings could not be read")?;
    Ok(Some(record))
}

/// Register the webhook channel into the Host's registry when one is
/// configured, and register nothing when none is.
///
/// Called from the state construction the Host already owns, so the existing
/// attempt-cycle driver reaches the channel with no new dispatch arm and no
/// second registry. A Host with no webhook record is not an error: it simply has
/// no outbound webhook, which is the documented behaviour rather than a
/// degraded one. Every other failure — a record this build cannot read, an
/// endpoint the policy refuses — is returned so the caller can report it
/// without failing the boot.
pub(crate) fn register(
    registry: &mut AdapterRegistry,
    db: &Database,
    secrets: &SecretStore,
) -> Result<()> {
    let Some(record) = stored_record(db)? else {
        return Ok(());
    };
    // The token is optional: a sink that authenticates by its own URL path or
    // that is only reachable on this machine posts without one.
    let token = secrets.get(BEARER_TOKEN_SECRET_REF)?;
    let config = WebhookConfig::from_record(&record, token, crate::network_policy::relaxed())?;
    let mut adapter = WebhookAdapter::new().configure(config);
    adapter.connect()?;
    registry.register(CHANNEL, Box::new(adapter))
}

#[cfg(test)]
mod tests;
