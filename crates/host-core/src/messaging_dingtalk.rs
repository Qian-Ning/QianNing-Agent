//! The outbound DingTalk channel.
//!
//! Delivers the same redacted summary the webhook, Telegram, Slack, Discord and
//! Mattermost channels carry, over the platform's group-send API. It does not sit
//! on [`HttpChannelAdapter`](crate::messaging_outbound) because one attempt here is
//! two requests: DingTalk authenticates a send with a short lived access token that
//! the app trades its AppKey and AppSecret for, and that token dies after two hours
//! while a Host may run for days. The ticket is fetched per attempt, which the
//! platform documents as returning the same token and renewing it, so there is no
//! cache in this module and therefore no cache to go stale, to race, or to
//! invalidate when the AppSecret is edited.
//!
//! Everything else is the family's: the endpoint rule, the status classification, the
//! bounded failure detail, and the channel name the ledger keys on.
//!
//! # Direction
//!
//! Outbound only. DingTalk's inbound direction is a websocket Stream client and it
//! lives beside the agent, in `packages/agent-host/src/messaging-dingtalk-inbound.ts`,
//! because it owns a socket, a heartbeat and a per-frame ack. No websocket client is
//! added here.
//!
//! # Configuration
//!
//! No migration and no schema change: the same key/value settings row every host
//! feature reads, under a `messagingDingtalk` section the settings write path and the
//! agent-host wiring already use.
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-dingtalk",
//!   "version": 1,
//!   "endpoint": "https://api.dingtalk.com",
//!   "destination": "<openConversationId>",
//!   "requestTimeoutMs": 10000
//! }
//! ```

use anyhow::{bail, Context, Result};
use reqwest::header::{HeaderValue, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

use crate::db::Database;
use crate::messaging_adapter::{
    AdapterRegistry, FailureKind, OutboundAdapter, OutboundMessage, SendResult,
};
use crate::messaging_outbound::{
    bounded, classify_status, classify_transport, envelope_text, failed, request_timeout,
    validate_https_endpoint,
};
use crate::secrets::SecretStore;
use std::time::Duration;

/// The delivery channel this adapter serves and the name it registers under.
///
/// The registry's name is the ledger's channel, so the Host wiring that redacts an
/// event must enqueue to this value; anything else is refused before it is persisted.
pub(crate) const CHANNEL: &str = "dingtalk";

/// The settings section the record lives in, inside the existing `app` row.
const SETTINGS_SECTION: &str = "messagingDingtalk";
/// The record's self-identifying format, beside its siblings' own.
const FORMAT: &str = "pi-desktop-messaging-dingtalk";
const FORMAT_VERSION: u32 = 1;

/// Where the two client credentials live in the secret store.
const CLIENT_ID_SECRET_REF: &str = "secret:messaging-dingtalk:client-id";
const CLIENT_SECRET_SECRET_REF: &str = "secret:messaging-dingtalk:client-secret";

/// The error code every refusal here carries.
const CODE: &str = "MESSAGING_DINGTALK_INVALID";
/// The channel's own word for itself, used only to build failure details.
const LABEL: &str = "dingtalk";

/// The token exchange, appended to the configured platform origin.
const TOKEN_PATH: &str = "/v1.0/oauth2/accessToken";
/// The group send method, appended to the configured platform origin.
const SEND_PATH: &str = "/v1.0/robot/groupMessages/send";
/// The header the send API takes its access token in, per the platform's docs.
const TOKEN_HEADER: &str = "x-acs-dingtalk-access-token";
/// The template for a plain text card.
const MSG_KEY: &str = "sampleText";

/// The stored record, exactly as the `messagingDingtalk` settings section carries it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    format: String,
    version: u32,
    endpoint: String,
    destination: String,
    #[serde(default)]
    request_timeout_ms: Option<u64>,
}

/// Validate the record's self-identifying header.
fn check_record(record: &StoredConfig) -> Result<()> {
    if record.format != FORMAT {
        bail!(
            "{CODE}: unsupported dingtalk settings record '{}'",
            record.format
        );
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: dingtalk settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

/// One address on the configured platform origin.
///
/// The endpoint is validated on its own, without any credential, and the path is
/// then appended by hand: `Url::join` would drop a base path the user configured
/// behind a reverse proxy, the same reason the sibling channels build their send
/// URLs by string and never by join.
fn platform_url(
    record: &StoredConfig,
    allow_insecure_http: bool,
    path: &str,
) -> Result<reqwest::Url> {
    check_record(record)?;
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    reqwest::Url::parse(&format!("{base}{path}"))
        .with_context(|| format!("{CODE}: the endpoint does not form a {path} URL"))
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
        .with_context(|| format!("{CODE}: the dingtalk settings could not be read"))?;
    Ok(Some(record))
}

/// Register the channel into the Host's registry when one is configured.
///
/// Called from the state construction the Host already owns, beside the sibling
/// registrations, so the existing attempt-cycle driver reaches this channel with no
/// new dispatch arm and no second registry. A Host with no record is not an error:
/// it simply has no DingTalk channel. A configured channel whose credentials are
/// missing is an error, because this API cannot be reached anonymously and a channel
/// that silently never delivers is worse than one that failed to register.
pub(crate) fn register(
    registry: &mut AdapterRegistry,
    db: &Database,
    secrets: &SecretStore,
) -> Result<()> {
    let Some(record) = stored_record(db)? else {
        return Ok(());
    };
    let app_key = secrets
        .get(CLIENT_ID_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no app key is configured"))?;
    let app_secret = secrets
        .get(CLIENT_SECRET_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no app secret is configured"))?;
    let adapter = configured_adapter(
        &record,
        &app_key,
        &app_secret,
        crate::network_policy::relaxed(),
    )?;
    registry.register(CHANNEL, Box::new(adapter))
}

/// Build and connect the adapter a configured record and credentials describe.
///
/// Shared by [`register`] and the tests, so a test drives exactly the adapter the
/// Host would register.
fn configured_adapter(
    record: &StoredConfig,
    app_key: &str,
    app_secret: &str,
    allow_insecure_http: bool,
) -> Result<DingtalkAdapter> {
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination conversation is empty");
    }
    let app_key = app_key.trim();
    if app_key.is_empty() {
        bail!("{CODE}: the configured app key is empty");
    }
    let app_secret = app_secret.trim();
    if app_secret.is_empty() {
        bail!("{CODE}: the configured app secret is empty");
    }
    let token_url = platform_url(record, allow_insecure_http, TOKEN_PATH)?;
    let send_url = platform_url(record, allow_insecure_http, SEND_PATH)?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = DingtalkAdapter {
        token_url,
        send_url,
        destination: destination.to_string(),
        app_key: app_key.to_string(),
        app_secret: app_secret.to_string(),
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

/// One configured DingTalk channel: where to trade the credentials, where to post,
/// and who is talking.
///
/// Deliberately not `Debug`: it holds the AppKey and AppSecret, and no failure path
/// or log line may print either.
struct DingtalkAdapter {
    /// The absolute token exchange URL, validated once at registration.
    token_url: reqwest::Url,
    /// The absolute group-send URL, validated once at registration.
    send_url: reqwest::Url,
    /// The `openConversationId` the summary is posted to.
    destination: String,
    app_key: String,
    app_secret: String,
    timeout: Duration,
    /// `None` until [`connect`](OutboundAdapter::connect), so the "not connected"
    /// answer is a fact about the adapter and not a flag beside it.
    client: Option<Client>,
}

impl OutboundAdapter for DingtalkAdapter {
    /// Build the HTTP client once. No request is made and no listener is opened:
    /// the ticket is fetched per attempt, so there is nothing to warm here.
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            // A redirected POST would carry the access token to whatever host the
            // endpoint names next, so a redirect is refused and classified as a
            // status like any other refusal.
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the dingtalk channel client")?;
        self.client = Some(client);
        Ok(())
    }

    /// Release the client. Safe on a never-connected adapter.
    fn disconnect(&mut self) -> Result<()> {
        self.client = None;
        Ok(())
    }

    /// One attempt: mint a ticket, then post the summary through it.
    ///
    /// A ticket that cannot be minted never reaches the send, and its refusal is
    /// classified on its own evidence rather than being folded into a send failure:
    /// a refused credential is terminal, a throttled exchange is not.
    fn send(&self, message: &OutboundMessage) -> SendResult {
        let Some(client) = self.client.as_ref() else {
            return failed(
                FailureKind::Retryable,
                &format!("the {LABEL} adapter is not connected"),
            );
        };
        self.attempt(client, message)
    }
}

impl DingtalkAdapter {
    /// One attempt, end to end: mint a ticket and post the summary through it.
    ///
    /// Both requests run on one current-thread runtime, the same shape the shared
    /// transport worker uses (`run_worker` in [`crate::messaging_outbound`]). The
    /// runtime is built per attempt rather than held, so an attempt that panics
    /// inside reqwest cannot poison the next one, and a shutdown needs nothing to
    /// unwind: the runtime dies with the attempt that owns it.
    fn attempt(&self, client: &Client, message: &OutboundMessage) -> SendResult {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                return failed(
                    FailureKind::Retryable,
                    &bounded(&format!(
                        "the {LABEL} delivery runtime is unavailable: {error}"
                    )),
                );
            }
        };
        let token = match runtime.block_on(self.exchange_token(client)) {
            TokenOutcome::Minted(token) => token,
            TokenOutcome::Refused(detail) => return failed(FailureKind::Terminal, &detail),
            TokenOutcome::Unavailable(detail) => return failed(FailureKind::Retryable, &detail),
        };
        runtime.block_on(self.post(client, &token, message))
    }

    /// Trade the app's own credentials for a two hour access token.
    async fn exchange_token(&self, client: &Client) -> TokenOutcome {
        let answer = client
            .post(self.token_url.clone())
            .header(CONTENT_TYPE, "application/json")
            .body(
                json!({ "appKey": self.app_key, "appSecret": self.app_secret })
                    .to_string()
                    .into_bytes(),
            )
            .send()
            .await;
        let response = match answer {
            Ok(response) => response,
            // A transport failure at the token step says nothing about the
            // credential itself, so it keeps the shared reading: a condition the
            // next attempt may not meet is retryable, the rest is not.
            Err(error) => return transport_outcome(&error),
        };
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return refusal_outcome(status, &body);
        }
        match access_token_in(&body) {
            Some(token) => TokenOutcome::Minted(token),
            None => TokenOutcome::Unavailable(bounded(&format!(
                "the {LABEL} token endpoint answered {status} without an access token"
            ))),
        }
    }

    /// Post the summary through a freshly minted ticket.
    async fn post(&self, client: &Client, token: &str, message: &OutboundMessage) -> SendResult {
        // The platform reads the summary out of a template parameter that is itself
        // a JSON string, so the text is encoded into one rather than sent as an
        // object: `{"content":"..."}` inside a string.
        let msg_param = json!({ "content": envelope_text(message) }).to_string();
        let body = json!({
            "msgKey": MSG_KEY,
            "msgParam": msg_param,
            "openConversationId": self.destination,
            // On DingTalk the robot code is the app's Client ID, which is the AppKey
            // the user already stored.
            "robotCode": self.app_key,
        });
        let header = match HeaderValue::from_str(token) {
            Ok(mut value) => {
                value.set_sensitive(true);
                value
            }
            Err(_) => {
                // The token came from the platform, so a value unsuitable for a
                // header is a refusal of this app and not of this delivery.
                return failed(
                    FailureKind::Terminal,
                    &bounded(&format!(
                        "{CODE}: the access token is not a valid header value"
                    )),
                );
            }
        };
        let answer = client
            .post(self.send_url.clone())
            .header(TOKEN_HEADER, header)
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_string().into_bytes())
            .send()
            .await;
        let response = match answer {
            Ok(response) => response,
            Err(error) => return transport_failure(&error),
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            return SendResult::Delivered { remote_id: None };
        }
        let (kind, detail) = refusal_of(status, &text);
        failed(kind, &detail)
    }
}

/// Read the access token out of a token answer, if the answer carries one.
fn access_token_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let token = value.get("accessToken")?.as_str()?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// What the token exchange yielded, or why it did not.
///
/// The three arms are three different ledger futures, so the exchange decides the
/// arm rather than leaving the caller to re-read an error string: a ticket is
/// usable, an app the platform does not know will never be known on any backoff,
/// and everything else is a condition the next attempt may not meet.
enum TokenOutcome {
    /// A usable access token, minted for this attempt alone.
    Minted(String),
    /// The platform refused the app itself. No later attempt can clear it.
    Refused(String),
    /// The exchange failed in a way the next attempt may not.
    Unavailable(String),
}

/// The platform's own names for an app refusal, as opposed to a refusal of this
/// particular delivery.
const CREDENTIAL_CODES: [&str; 3] = [
    "invalidClientIdOrSecret",
    "invalidAuthentication",
    "Forbidden.AccessDenied.AccessTokenPermissionDenied",
];

/// What one failed response means: a kind and a bounded detail.
///
/// The status decides the kind, exactly as it does for the sibling channels; the
/// body only adds the platform's own name to the detail, because `400` alone does
/// not tell an operator whether to fix a permission, a chat id or a rotated secret.
fn refusal_of(status: StatusCode, body: &str) -> (FailureKind, String) {
    let kind = match classify_status(status, LABEL) {
        SendResult::Failed { kind, .. } => kind,
        // Unreachable by construction: this is only called for a non-2xx status,
        // which the shared rule never records as a delivery. Kept as a term instead
        // of a panic so a future change to that rule cannot turn a refusal into one.
        SendResult::Delivered { .. } => FailureKind::Terminal,
    };
    let detail = match body_code(body) {
        Some(code) => bounded(&format!(
            "the {LABEL} endpoint answered HTTP {status} ({code})"
        )),
        None => bounded(&format!("the {LABEL} endpoint answered HTTP {status}")),
    };
    (kind, detail)
}

/// The platform's `code` from a refusal body, bounded by the fact it is an
/// identifier and never free text from the receiver.
fn body_code(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    value
        .get("code")
        .and_then(Value::as_str)
        .map(|code| code.chars().take(64).collect())
}

/// A transport failure on the send, read by the shared rule.
fn transport_failure(error: &reqwest::Error) -> SendResult {
    match classify_transport(error, LABEL) {
        SendResult::Failed { kind, detail } => failed(kind, &detail),
        SendResult::Delivered { .. } => failed(
            FailureKind::Retryable,
            "the dingtalk transport reported an impossible delivery",
        ),
    }
}

/// A transport failure at the token step, read by the same rule a send's failure is.
fn transport_outcome(error: &reqwest::Error) -> TokenOutcome {
    match classify_transport(error, LABEL) {
        SendResult::Failed { kind, detail } => match kind {
            FailureKind::Retryable => TokenOutcome::Unavailable(bounded(&detail)),
            FailureKind::Terminal => TokenOutcome::Refused(bounded(&detail)),
        },
        SendResult::Delivered { .. } => {
            TokenOutcome::Unavailable(bounded("the dingtalk token exchange cannot deliver"))
        }
    }
}

/// A failed token exchange, as the next attempt should read it.
///
/// An app the platform does not know, or will not let fetch a token, will answer
/// the same way on every backoff: that is the one refusal this channel calls
/// terminal here. Everything else keeps the shared status rule.
fn refusal_outcome(status: StatusCode, body: &str) -> TokenOutcome {
    let (kind, detail) = refusal_of(status, body);
    if body_code(body).is_some_and(|code| CREDENTIAL_CODES.contains(&code.as_str())) {
        return TokenOutcome::Refused(detail);
    }
    match kind {
        FailureKind::Retryable => TokenOutcome::Unavailable(detail),
        FailureKind::Terminal => TokenOutcome::Refused(detail),
    }
}

#[cfg(test)]
mod tests;
