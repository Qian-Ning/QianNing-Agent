//! The outbound Feishu (Lark) channel.
//!
//! Delivers the same redacted summary the other channels carry, through Feishu's
//! `im/v1/messages` API. Like DingTalk, one attempt here is two requests: a
//! Feishu app trades its id and secret for a `tenant_access_token`, and that
//! token expires after two hours while a Host may run for days. The ticket is
//! therefore minted per attempt and never cached, so there is no cache to go
//! stale when the secret is edited.
//!
//! # Two directional credentials
//!
//! *Send* needs the app id and app secret (this module). *Receive* — the event
//! subscription Feishu posts to the app's Request URL — is authenticated by a
//! separate verification token, and lives in
//! `packages/agent-host/src/messaging-feishu-inbound.ts` because it is an HTTP
//! surface rather than a transport this module owns.
//!
//! # Feishu answers refusals with HTTP 200
//!
//! Unlike a plain REST API, a refused Feishu call arrives as `200 OK` with
//! `{"code": <non-zero>, "msg": "..."}`. A channel that only read the status
//! would report every rejection as a delivery, so this adapter reads the body's
//! own `code` and classifies on it.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-feishu",
//!   "version": 1,
//!   "endpoint": "https://open.feishu.cn",
//!   "destination": "<chat id, oc_…>",
//!   "requestTimeoutMs": 10000
//! }
//! ```

use anyhow::{bail, Context, Result};
use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::time::Duration;

use crate::db::Database;
use crate::messaging_adapter::{
    AdapterRegistry, FailureKind, OutboundAdapter, OutboundMessage, SendResult,
};
use crate::messaging_outbound::{
    bounded, classify_status, classify_transport, envelope_text, failed, request_timeout,
    validate_https_endpoint,
};
use crate::secrets::SecretStore;

/// The delivery channel this adapter serves and the name it registers under.
pub(crate) const CHANNEL: &str = "feishu";

/// The settings section the record lives in, inside the existing `app` row.
const SETTINGS_SECTION: &str = "messagingFeishu";
/// The record's self-identifying format.
const FORMAT: &str = "pi-desktop-messaging-feishu";
const FORMAT_VERSION: u32 = 1;

/// Where the app credentials live in the secret store.
const APP_ID_SECRET_REF: &str = "secret:messaging-feishu:app-id";
const APP_SECRET_SECRET_REF: &str = "secret:messaging-feishu:app-secret";

/// The error code every refusal here carries.
const CODE: &str = "MESSAGING_FEISHU_INVALID";
/// The channel's own word for itself, used only to build failure details.
const LABEL: &str = "feishu";

/// The token exchange, appended to the configured platform origin.
const TOKEN_PATH: &str = "/open-apis/auth/v3/tenant_access_token/internal";
/// The send method, appended to the configured platform origin.
const SEND_PATH: &str = "/open-apis/im/v1/messages?receive_id_type=chat_id";

/// The stored record, exactly as the `messagingFeishu` settings section carries it.
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
            "{CODE}: unsupported feishu settings record '{}'",
            record.format
        );
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: feishu settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

/// One address on the configured platform origin.
///
/// Built by string, never by `Url::join`, so a base path the user put behind a
/// reverse proxy survives.
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
        .with_context(|| format!("{CODE}: the feishu settings could not be read"))?;
    Ok(Some(record))
}

/// Register the channel into the Host's registry when one is configured.
pub(crate) fn register(
    registry: &mut AdapterRegistry,
    db: &Database,
    secrets: &SecretStore,
) -> Result<()> {
    let Some(record) = stored_record(db)? else {
        return Ok(());
    };
    let app_id = secrets
        .get(APP_ID_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no app id is configured"))?;
    let app_secret = secrets
        .get(APP_SECRET_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no app secret is configured"))?;
    let adapter = configured_adapter(
        &record,
        &app_id,
        &app_secret,
        crate::network_policy::relaxed(),
    )?;
    registry.register(CHANNEL, Box::new(adapter))
}

/// Build and connect the adapter a configured record and credentials describe.
fn configured_adapter(
    record: &StoredConfig,
    app_id: &str,
    app_secret: &str,
    allow_insecure_http: bool,
) -> Result<FeishuAdapter> {
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination chat is empty");
    }
    let app_id = app_id.trim();
    if app_id.is_empty() {
        bail!("{CODE}: the configured app id is empty");
    }
    let app_secret = app_secret.trim();
    if app_secret.is_empty() {
        bail!("{CODE}: the configured app secret is empty");
    }
    let token_url = platform_url(record, allow_insecure_http, TOKEN_PATH)?;
    let send_url = platform_url(record, allow_insecure_http, SEND_PATH)?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = FeishuAdapter {
        token_url,
        send_url,
        destination: destination.to_string(),
        app_id: app_id.to_string(),
        app_secret: app_secret.to_string(),
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

/// One configured Feishu channel: where to trade the credentials, where to post,
/// and which chat receives.
///
/// Deliberately not `Debug`: it holds the app secret.
struct FeishuAdapter {
    token_url: reqwest::Url,
    send_url: reqwest::Url,
    destination: String,
    app_id: String,
    app_secret: String,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for FeishuAdapter {
    /// Build the HTTP client once. No request is made: the ticket is per attempt.
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            // A redirected POST would carry the bearer token elsewhere.
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the feishu channel client")?;
        self.client = Some(client);
        Ok(())
    }

    fn disconnect(&mut self) -> Result<()> {
        self.client = None;
        Ok(())
    }

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

impl FeishuAdapter {
    /// One attempt, end to end: mint a tenant token, then post through it.
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

    /// Trade the app's id and secret for a `tenant_access_token`.
    async fn exchange_token(&self, client: &Client) -> TokenOutcome {
        let answer = client
            .post(self.token_url.clone())
            .header(CONTENT_TYPE, "application/json")
            .body(
                json!({ "app_id": self.app_id, "app_secret": self.app_secret })
                    .to_string()
                    .into_bytes(),
            )
            .send()
            .await;
        let response = match answer {
            Ok(response) => response,
            Err(error) => return transport_outcome(&error),
        };
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return refusal_outcome(status, &body);
        }
        // A refusal may still arrive as 200 with a non-zero code.
        if let Some(code) = body_code(&body) {
            if code != 0 {
                return match classify_body_refusal(code) {
                    FailureKind::Terminal => {
                        TokenOutcome::Refused(refusal_detail(&body, "token endpoint"))
                    }
                    FailureKind::Retryable => {
                        TokenOutcome::Unavailable(refusal_detail(&body, "token endpoint"))
                    }
                };
            }
        }
        match tenant_token_in(&body) {
            Some(token) => TokenOutcome::Minted(token),
            None => TokenOutcome::Unavailable(bounded(&format!(
                "the {LABEL} token endpoint answered {status} without a tenant token"
            ))),
        }
    }

    /// Post the summary through a freshly minted token.
    async fn post(&self, client: &Client, token: &str, message: &OutboundMessage) -> SendResult {
        // Feishu takes `content` as a JSON *string*, so the text is encoded into
        // one rather than sent as a nested object.
        let content = json!({ "text": envelope_text(message) }).to_string();
        let body = json!({
            "receive_id": self.destination,
            "msg_type": "text",
            "content": content,
        });
        let header = match HeaderValue::from_str(&format!("Bearer {token}")) {
            Ok(mut value) => {
                value.set_sensitive(true);
                value
            }
            Err(_) => {
                return failed(
                    FailureKind::Terminal,
                    &bounded(&format!(
                        "{CODE}: the tenant token is not a valid header value"
                    )),
                );
            }
        };
        let answer = client
            .post(self.send_url.clone())
            .header(AUTHORIZATION, header)
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
        match body_code(&text) {
            // `0` is Feishu's own "ok"; anything else is a refusal even when the
            // HTTP status says 200.
            Some(0) if status.is_success() => SendResult::Delivered {
                remote_id: message_id_in(&text),
            },
            Some(code) => {
                let kind = classify_body_refusal(code);
                failed(kind, &refusal_detail(&text, "send"))
            }
            None if status.is_success() => SendResult::Delivered { remote_id: None },
            None => {
                let (kind, detail) = refusal_of(status, &text);
                failed(kind, &detail)
            }
        }
    }
}

/// Read the tenant token out of a token answer.
fn tenant_token_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let token = value.get("tenant_access_token")?.as_str()?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// The message id Feishu returns for a delivered message, when it does.
fn message_id_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let id = value.get("data")?.get("message_id")?.as_str()?.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// What the token exchange yielded, or why it did not.
enum TokenOutcome {
    Minted(String),
    Refused(String),
    Unavailable(String),
}

/// The platform's numeric code from a body, if the body carries one.
fn body_code(body: &str) -> Option<i64> {
    let value: Value = serde_json::from_str(body).ok()?;
    value.get("code").and_then(Value::as_i64)
}

/// Feishu's own codes that mean "the app itself is wrong", as opposed to a
/// throttle or a transient fault.
///
/// `99991661` is an unknown app id or secret, `99991663` an unusable token,
/// `99991672` a permission the app was never granted. None of them clears on a
/// backoff, so a retry would only repeat the refusal five times.
const CREDENTIAL_CODES: [i64; 4] = [99991661, 99991663, 99991672, 99991668];

/// Feishu's throttle and transient codes, which a later attempt may not meet.
const RETRYABLE_CODES: [i64; 3] = [99991400, 99991401, 99991403];

/// What one non-zero body code means for the ledger.
fn classify_body_refusal(code: i64) -> FailureKind {
    if RETRYABLE_CODES.contains(&code) {
        FailureKind::Retryable
    } else if CREDENTIAL_CODES.contains(&code) {
        FailureKind::Terminal
    } else {
        // An unknown code is the platform refusing this request for a reason
        // this build does not model; treating it as terminal keeps the ledger
        // from hammering a call that keeps being refused.
        FailureKind::Terminal
    }
}

/// A bounded detail naming the platform's code and its own message.
fn refusal_detail(body: &str, step: &str) -> String {
    let value: Option<Value> = serde_json::from_str(body).ok();
    let code = value
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(Value::as_i64);
    let message = value
        .as_ref()
        .and_then(|value| value.get("msg"))
        .and_then(Value::as_str)
        .map(|text| text.chars().take(120).collect::<String>());
    match (code, message) {
        (Some(code), Some(message)) => bounded(&format!(
            "the {LABEL} {step} was refused (code {code}: {message})"
        )),
        (Some(code), None) => bounded(&format!("the {LABEL} {step} was refused (code {code})")),
        _ => bounded(&format!("the {LABEL} {step} was refused")),
    }
}

/// What one failed non-2xx response means: a kind and a bounded detail.
fn refusal_of(status: StatusCode, body: &str) -> (FailureKind, String) {
    let kind = match classify_status(status, LABEL) {
        SendResult::Failed { kind, .. } => kind,
        SendResult::Delivered { .. } => FailureKind::Terminal,
    };
    (kind, refusal_detail(body, "endpoint"))
}

/// A transport failure on the send, read by the shared rule.
fn transport_failure(error: &reqwest::Error) -> SendResult {
    match classify_transport(error, LABEL) {
        SendResult::Failed { kind, detail } => failed(kind, &detail),
        SendResult::Delivered { .. } => failed(
            FailureKind::Retryable,
            "the feishu transport reported an impossible delivery",
        ),
    }
}

/// A transport failure at the token step.
fn transport_outcome(error: &reqwest::Error) -> TokenOutcome {
    match classify_transport(error, LABEL) {
        SendResult::Failed {
            kind: FailureKind::Terminal,
            detail,
        } => TokenOutcome::Refused(detail),
        SendResult::Failed { detail, .. } => TokenOutcome::Unavailable(detail),
        SendResult::Delivered { .. } => TokenOutcome::Unavailable(bounded(
            "the feishu transport reported an impossible token exchange",
        )),
    }
}

/// A failed token exchange, as the next attempt should read it.
fn refusal_outcome(status: StatusCode, body: &str) -> TokenOutcome {
    if let Some(code) = body_code(body) {
        if code != 0 {
            let detail = refusal_detail(body, "token endpoint");
            return match classify_body_refusal(code) {
                FailureKind::Terminal => TokenOutcome::Refused(detail),
                FailureKind::Retryable => TokenOutcome::Unavailable(detail),
            };
        }
    }
    let (kind, detail) = refusal_of(status, body);
    match kind {
        FailureKind::Retryable => TokenOutcome::Unavailable(detail),
        FailureKind::Terminal => TokenOutcome::Refused(detail),
    }
}

#[cfg(test)]
mod tests;
