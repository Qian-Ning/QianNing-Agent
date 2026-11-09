//! The outbound WeChat Official Account channel.
//!
//! # Two calls, and errors that arrive as `errcode`
//!
//! Sending is a customer-service message: fetch an `access_token` with the app
//! id and secret, then post the text addressed to the sender's open id. WeChat
//! answers HTTP 200 for failures too — the verdict is in `errcode` — so this
//! module classifies by that number rather than by status.
//!
//! # The 48-hour window is terminal, not retryable
//!
//! A customer-service message is only accepted within 48 hours of the user's
//! last message (`45015`), and an invalid credential (`40001`) never starts
//! working by being retried. Both are terminal. Rate limiting (`45009`) and
//! WeChat's own busy signal (`-1`) are the two worth another attempt.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-weixin",
//!   "version": 1,
//!   "endpoint": "https://api.weixin.qq.com",
//!   "destination": "oUser123",
//!   "requestTimeoutMs": 10000
//! }
//! ```

use anyhow::{bail, Context, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

use crate::db::Database;
use crate::messaging_adapter::{
    AdapterRegistry, FailureKind, OutboundAdapter, OutboundMessage, SendResult,
};
use crate::messaging_outbound::{
    bounded, classify_transport, envelope_text, failed, request_timeout, validate_https_endpoint,
};
use crate::secrets::SecretStore;

pub(crate) const CHANNEL: &str = "weixin";

const SETTINGS_SECTION: &str = "messagingWeixin";
const FORMAT: &str = "pi-desktop-messaging-weixin";
const FORMAT_VERSION: u32 = 1;
const APP_ID_SECRET_REF: &str = "secret:messaging-weixin:app-id";
const APP_SECRET_SECRET_REF: &str = "secret:messaging-weixin:app-secret";

const CODE: &str = "MESSAGING_WEIXIN_INVALID";
const LABEL: &str = "wechat";

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
) -> Result<WeixinAdapter> {
    check_record(record)?;
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination open id is empty");
    }
    let app_id = app_id.trim();
    let app_secret = app_secret.trim();
    if app_id.is_empty() || app_secret.is_empty() {
        bail!("{CODE}: the app registration is incomplete");
    }
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    let token_url = reqwest::Url::parse_with_params(
        &format!("{base}/cgi-bin/token"),
        &[
            ("grant_type", "client_credential"),
            ("appid", app_id),
            ("secret", app_secret),
        ],
    )
    .with_context(|| format!("{CODE}: the endpoint does not form a token URL"))?;
    let send_url = reqwest::Url::parse(&format!("{base}/cgi-bin/message/custom/send"))
        .with_context(|| format!("{CODE}: the endpoint does not form a send URL"))?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = WeixinAdapter {
        token_url,
        send_url,
        destination: destination.to_string(),
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct WeixinAdapter {
    token_url: reqwest::Url,
    send_url: reqwest::Url,
    destination: String,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for WeixinAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the wechat client")?;
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

impl WeixinAdapter {
    async fn access_token(&self, client: &Client) -> TokenOutcome {
        let answer = client.get(self.token_url.clone()).send().await;
        let response = match answer {
            Ok(response) => response,
            Err(error) => {
                return match classify_transport(&error, LABEL) {
                    SendResult::Failed { detail, .. } => TokenOutcome::Unavailable(detail),
                    SendResult::Delivered { .. } => TokenOutcome::Unavailable(bounded(
                        "the wechat token transport reported an impossible delivery",
                    )),
                }
            }
        };
        let body = response.text().await.unwrap_or_default();
        match access_token_in(&body) {
            Some(token) => TokenOutcome::Minted(token),
            None => {
                // WeChat answers 200 with an errcode; a credential error is not
                // going to become correct on a retry.
                let code = errcode_in(&body);
                if matches!(code, Some(40013) | Some(40125) | Some(40001)) {
                    TokenOutcome::Refused(bounded(&format!(
                        "the {LABEL} token endpoint refused the app credential (errcode {})",
                        code.unwrap_or(0)
                    )))
                } else {
                    TokenOutcome::Unavailable(bounded(&format!(
                        "the {LABEL} token endpoint answered without a token (errcode {})",
                        code.unwrap_or(-1)
                    )))
                }
            }
        }
    }

    async fn post(&self, client: &Client, token: &str, message: &OutboundMessage) -> SendResult {
        let send_url = match self.send_url_with_token(token) {
            Ok(url) => url,
            Err(detail) => return failed(FailureKind::Terminal, &detail),
        };
        let body = json!({
            "touser": self.destination,
            "msgtype": "text",
            "text": { "content": envelope_text(message) },
        });
        let answer = client
            .post(send_url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
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
                        "the wechat transport reported an impossible delivery",
                    ),
                }
            }
        };
        let text = response.text().await.unwrap_or_default();
        match errcode_in(&text) {
            Some(0) => SendResult::Delivered { remote_id: None },
            Some(code) => failed(weixin_failure_kind(code), &weixin_detail(code)),
            None => failed(
                FailureKind::Retryable,
                &bounded(&format!("the {LABEL} endpoint answered without an errcode")),
            ),
        }
    }

    /// The access token travels in the query string, as WeChat requires.
    fn send_url_with_token(&self, token: &str) -> std::result::Result<reqwest::Url, String> {
        let mut url = self.send_url.clone();
        url.query_pairs_mut().append_pair("access_token", token);
        Ok(url)
    }
}

/// Which failures are worth another attempt.
fn weixin_failure_kind(code: i64) -> FailureKind {
    match code {
        // Rate limited, or WeChat's own "system busy".
        45009 | -1 => FailureKind::Retryable,
        // Credential, permission and the 48-hour window: retrying cannot fix any
        // of them.
        _ => FailureKind::Terminal,
    }
}

fn weixin_detail(code: i64) -> String {
    let meaning = match code {
        40001 | 40125 | 40013 => "the app credential is not accepted",
        45015 => "the 48-hour reply window has closed",
        45009 => "the daily API limit is reached",
        -1 => "wechat is busy",
        _ => "the platform refused the message",
    };
    bounded(&format!(
        "the {LABEL} endpoint answered errcode {code}: {meaning}"
    ))
}

fn errcode_in(body: &str) -> Option<i64> {
    let value: Value = serde_json::from_str(body).ok()?;
    value.get("errcode")?.as_i64()
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

#[cfg(test)]
mod tests;
