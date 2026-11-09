//! The outbound QQ bot channel.
//!
//! # A token per call, and two headers
//!
//! QQ mints an access token from the app id and secret at a fixed host, and the
//! send carries it as `Authorization: QQBot <token>` — not `Bearer`. The token
//! is short-lived and this module never caches it: a send is one message, and a
//! cached token that expired between sends is a failure the caller cannot see
//! coming.
//!
//! # Active, not passive
//!
//! A passive reply quotes the inbound message id and lives sixty minutes; an
//! active message has no such id and is capped at four per user per month. This
//! adapter sends active messages because the delivery ledger carries a
//! destination, not the message being answered — the panel says so, and the cap
//! is a platform rule rather than something this side can work around.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-qqbot",
//!   "version": 1,
//!   "endpoint": "https://api.sgroup.qq.com",
//!   "destination": "<user openid>",
//!   "requestTimeoutMs": 10000
//! }
//! ```

use anyhow::{bail, Context, Result};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
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

pub(crate) const CHANNEL: &str = "qqBot";

const SETTINGS_SECTION: &str = "messagingQqbot";
const FORMAT: &str = "pi-desktop-messaging-qqbot";
const FORMAT_VERSION: u32 = 1;
const APP_ID_SECRET_REF: &str = "secret:messaging-qqbot:app-id";
const APP_SECRET_SECRET_REF: &str = "secret:messaging-qqbot:app-secret";

/// Where QQ mints tokens; it is the same host for every bot.
const TOKEN_URL: &str = "https://bots.qq.com/app/getAppAccessToken";

const CODE: &str = "MESSAGING_QQBOT_INVALID";
const LABEL: &str = "qq bot";

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

fn check_record(record: &StoredConfig) -> Result<()> {
    if record.format != FORMAT {
        bail!("{CODE}: unsupported settings record '{}'", record.format);
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

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
        .with_context(|| format!("{CODE}: the settings could not be read"))?;
    Ok(Some(record))
}

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
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no app id is stored"))?;
    let app_secret = secrets
        .get(APP_SECRET_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no app secret is stored"))?;
    let adapter = configured_adapter(
        &record,
        &app_id,
        &app_secret,
        crate::network_policy::relaxed(),
    )?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(
    record: &StoredConfig,
    app_id: &str,
    app_secret: &str,
    allow_insecure_http: bool,
) -> Result<QqbotAdapter> {
    check_record(record)?;
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination open id is empty");
    }
    if destination.contains('/') || destination.contains('?') || destination.contains('#') {
        bail!("{CODE}: the destination open id is not a single path segment");
    }
    let app_id = app_id.trim();
    let app_secret = app_secret.trim();
    if app_id.is_empty() || app_secret.is_empty() {
        bail!("{CODE}: the app registration is incomplete");
    }
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    let send_url = reqwest::Url::parse(&format!("{base}/v2/users/{destination}/messages"))
        .with_context(|| format!("{CODE}: the endpoint does not form a message URL"))?;
    let token_url = reqwest::Url::parse(TOKEN_URL).context("parse the qq token URL")?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = QqbotAdapter {
        send_url,
        token_url,
        app_id: app_id.to_string(),
        app_secret: app_secret.to_string(),
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct QqbotAdapter {
    send_url: reqwest::Url,
    token_url: reqwest::Url,
    app_id: String,
    app_secret: String,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for QqbotAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the qq client")?;
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
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                return failed(
                    FailureKind::Retryable,
                    &bounded(&format!("the {LABEL} runtime is unavailable: {error}")),
                )
            }
        };
        let token = match runtime.block_on(self.access_token(client)) {
            TokenOutcome::Minted(token) => token,
            TokenOutcome::Refused(detail) => return failed(FailureKind::Terminal, &detail),
            TokenOutcome::Unavailable(detail) => return failed(FailureKind::Retryable, &detail),
        };
        runtime.block_on(self.post(client, &token, message))
    }
}

enum TokenOutcome {
    Minted(String),
    Refused(String),
    Unavailable(String),
}

impl QqbotAdapter {
    async fn access_token(&self, client: &Client) -> TokenOutcome {
        let body = json!({ "appId": self.app_id, "clientSecret": self.app_secret });
        let answer = client
            .post(self.token_url.clone())
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_string().into_bytes())
            .send()
            .await;
        let response = match answer {
            Ok(response) => response,
            Err(error) => {
                return match classify_transport(&error, LABEL) {
                    SendResult::Failed { detail, .. } => TokenOutcome::Unavailable(detail),
                    SendResult::Delivered { .. } => TokenOutcome::Unavailable(bounded(
                        "the qq token transport reported an impossible delivery",
                    )),
                }
            }
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return match status {
                StatusCode::UNAUTHORIZED | StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN => {
                    TokenOutcome::Refused(bounded(&format!(
                        "the {LABEL} token endpoint refused the app registration (HTTP {status})"
                    )))
                }
                _ => TokenOutcome::Unavailable(bounded(&format!(
                    "the {LABEL} token endpoint answered HTTP {status}"
                ))),
            };
        }
        match access_token_in(&text) {
            Some(token) => TokenOutcome::Minted(token),
            None => TokenOutcome::Refused(bounded(&format!(
                "the {LABEL} token endpoint answered without a token (code {})",
                error_code_in(&text).unwrap_or(0)
            ))),
        }
    }

    async fn post(&self, client: &Client, token: &str, message: &OutboundMessage) -> SendResult {
        let body = json!({
            "content": envelope_text(message),
            "msg_type": 0,
            "msg_seq": 1,
        });
        let answer = client
            .post(self.send_url.clone())
            .header(AUTHORIZATION, format!("QQBot {token}"))
            .header(CONTENT_TYPE, "application/json; charset=utf-8")
            .body(body.to_string().into_bytes())
            .send()
            .await;
        let response = match answer {
            Ok(response) => response,
            Err(error) => {
                return match classify_transport(&error, LABEL) {
                    SendResult::Failed { kind, detail } => failed(kind, &detail),
                    SendResult::Delivered { .. } => failed(
                        FailureKind::Retryable,
                        "the qq transport reported an impossible delivery",
                    ),
                }
            }
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            return SendResult::Delivered {
                remote_id: message_id_in(&text),
            };
        }
        let kind = match classify_status(status, LABEL) {
            SendResult::Failed { kind, .. } => kind,
            SendResult::Delivered { .. } => FailureKind::Terminal,
        };
        failed(kind, &refusal_detail(status, &text))
    }
}

fn access_token_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let token = value.get("access_token")?.as_str()?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn error_code_in(body: &str) -> Option<i64> {
    let value: Value = serde_json::from_str(body).ok()?;
    value.get("code")?.as_i64()
}

fn message_id_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

fn refusal_detail(status: StatusCode, body: &str) -> String {
    let value: Option<Value> = serde_json::from_str(body).ok();
    let message = value
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .map(|text| text.chars().take(120).collect::<String>());
    match message {
        Some(message) => bounded(&format!(
            "the {LABEL} endpoint answered HTTP {status} ({message})"
        )),
        None => bounded(&format!("the {LABEL} endpoint answered HTTP {status}")),
    }
}

#[cfg(test)]
mod tests;
