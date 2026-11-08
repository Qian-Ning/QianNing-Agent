//! The outbound WeCom **group robot** channel.
//!
//! A group robot is not the app in `messaging_wecom.rs`: it has no corp id, no
//! secret, no token exchange and no inbound direction at all. It is one webhook
//! URL with a key in the query, and it only accepts a push — which is why the
//! panel marks this channel `receive: "none"` rather than pretending to run a
//! loop for it.
//!
//! # One request, one delivery
//!
//! The key lives in the secret store, never in the record, and it travels in the
//! query because that is the platform's own design. The endpoint is validated as
//! HTTPS before the URL is built, so a mistyped `http://` is refused at
//! registration rather than sent with the key in the clear.
//!
//! A refusal is HTTP 200 with a non-zero `errcode`, so the body decides.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-wecom-group",
//!   "version": 1,
//!   "endpoint": "https://qyapi.weixin.qq.com",
//!   "requestTimeoutMs": 10000
//! }
//! ```

use anyhow::{bail, Context, Result};
use reqwest::header::CONTENT_TYPE;
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
pub(crate) const CHANNEL: &str = "wecomGroup";

const SETTINGS_SECTION: &str = "messagingWecomGroup";
const FORMAT: &str = "pi-desktop-messaging-wecom-group";
const FORMAT_VERSION: u32 = 1;
const WEBHOOK_KEY_SECRET_REF: &str = "secret:messaging-wecom-group:key";

const CODE: &str = "MESSAGING_WECOM_GROUP_INVALID";
const LABEL: &str = "wecom group robot";
const SEND_PATH: &str = "/cgi-bin/webhook/send";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    format: String,
    version: u32,
    endpoint: String,
    #[serde(default)]
    request_timeout_ms: Option<u64>,
}

fn check_record(record: &StoredConfig) -> Result<()> {
    if record.format != FORMAT {
        bail!("{CODE}: unsupported record '{}'", record.format);
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

fn send_url(record: &StoredConfig, key: &str, allow_insecure_http: bool) -> Result<reqwest::Url> {
    check_record(record)?;
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    let mut url = reqwest::Url::parse(&format!("{base}{SEND_PATH}"))
        .with_context(|| format!("{CODE}: the endpoint does not form a {SEND_PATH} URL"))?;
    url.query_pairs_mut().append_pair("key", key);
    Ok(url)
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
    let key = secrets
        .get(WEBHOOK_KEY_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no webhook key is configured"))?;
    let adapter = configured_adapter(&record, &key, crate::network_policy::relaxed())?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(
    record: &StoredConfig,
    key: &str,
    allow_insecure_http: bool,
) -> Result<WecomGroupAdapter> {
    let key = key.trim();
    if key.is_empty() {
        bail!("{CODE}: the configured webhook key is empty");
    }
    let url = send_url(record, key, allow_insecure_http)?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = WecomGroupAdapter {
        url,
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct WecomGroupAdapter {
    url: reqwest::Url,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for WecomGroupAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            // A redirected POST would carry the key to whatever host is named next.
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the wecom group client")?;
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

impl WecomGroupAdapter {
    fn attempt(&self, client: &Client, message: &OutboundMessage) -> SendResult {
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
        runtime.block_on(self.post(client, message))
    }

    async fn post(&self, client: &Client, message: &OutboundMessage) -> SendResult {
        let body = json!({
            "msgtype": "text",
            "text": { "content": envelope_text(message) },
        });
        let answer = client
            .post(self.url.clone())
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
        match errcode(&text) {
            Some(0) if status.is_success() => SendResult::Delivered { remote_id: None },
            Some(code) => failed(classify_errcode(code), &refusal_detail(&text)),
            None if status.is_success() => SendResult::Delivered { remote_id: None },
            None => {
                let (kind, detail) = refusal_of(status, &text);
                failed(kind, &detail)
            }
        }
    }
}

fn errcode(body: &str) -> Option<i64> {
    let value: Value = serde_json::from_str(body).ok()?;
    value.get("errcode").and_then(Value::as_i64)
}

/// The key itself is wrong, or the robot was removed from the group.
const CREDENTIAL_CODES: [i64; 2] = [93000, 40001];
/// The platform's quota.
const RETRYABLE_CODES: [i64; 2] = [45009, 45033];

fn classify_errcode(code: i64) -> FailureKind {
    if RETRYABLE_CODES.contains(&code) {
        FailureKind::Retryable
    } else if CREDENTIAL_CODES.contains(&code) {
        FailureKind::Terminal
    } else {
        FailureKind::Terminal
    }
}

fn refusal_detail(body: &str) -> String {
    let value: Option<Value> = serde_json::from_str(body).ok();
    let code = value
        .as_ref()
        .and_then(|value| value.get("errcode"))
        .and_then(Value::as_i64);
    let message = value
        .as_ref()
        .and_then(|value| value.get("errmsg"))
        .and_then(Value::as_str)
        .map(|text| text.chars().take(120).collect::<String>());
    match (code, message) {
        (Some(code), Some(message)) => bounded(&format!(
            "the {LABEL} was refused (errcode {code}: {message})"
        )),
        (Some(code), None) => bounded(&format!("the {LABEL} was refused (errcode {code})")),
        _ => bounded(&format!("the {LABEL} was refused")),
    }
}

fn refusal_of(status: StatusCode, body: &str) -> (FailureKind, String) {
    let kind = match classify_status(status, LABEL) {
        SendResult::Failed { kind, .. } => kind,
        SendResult::Delivered { .. } => FailureKind::Terminal,
    };
    (kind, refusal_detail(body))
}

fn transport_failure(error: &reqwest::Error) -> SendResult {
    match classify_transport(error, LABEL) {
        SendResult::Failed { kind, detail } => failed(kind, &detail),
        SendResult::Delivered { .. } => failed(
            FailureKind::Retryable,
            "the wecom group transport reported an impossible delivery",
        ),
    }
}

#[cfg(test)]
mod tests;
