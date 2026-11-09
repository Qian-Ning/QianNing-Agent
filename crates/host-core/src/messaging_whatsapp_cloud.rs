//! The outbound WhatsApp Cloud API channel.
//!
//! # One hop, one bearer token
//!
//! Meta's Cloud API takes the message straight to
//! `https://graph.facebook.com/<version>/<phone-number-id>/messages` with a
//! bearer access token. There is no token exchange and no assertion — the
//! access token is minted in the Meta console and pasted into the secret store.
//!
//! # The phone number id lives in the endpoint
//!
//! Every other channel's record is an endpoint plus a destination, and this one
//! needs a third value: which business phone number is sending. Rather than give
//! this channel its own record shape, the number id is part of the endpoint path
//! — `https://graph.facebook.com/v21.0/999888777` — which is exactly what Meta's
//! documentation calls the message URL's base. The destination is then the
//! recipient, so one record still describes one conversation.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-whatsapp-cloud",
//!   "version": 1,
//!   "endpoint": "https://graph.facebook.com/v21.0/999888777",
//!   "destination": "15551234567",
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

pub(crate) const CHANNEL: &str = "whatsappCloud";

const SETTINGS_SECTION: &str = "messagingWhatsappCloud";
const FORMAT: &str = "pi-desktop-messaging-whatsapp-cloud";
const FORMAT_VERSION: u32 = 1;
const ACCESS_TOKEN_SECRET_REF: &str = "secret:messaging-whatsapp-cloud:access-token";

const CODE: &str = "MESSAGING_WHATSAPP_CLOUD_INVALID";
const LABEL: &str = "whatsapp cloud";

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

/// A recipient is a bare international number: digits, no plus, no spaces.
fn check_recipient(recipient: &str) -> Result<()> {
    if recipient.is_empty() {
        bail!("{CODE}: the destination number is empty");
    }
    if !recipient.chars().all(|c| c.is_ascii_digit()) {
        bail!("{CODE}: the destination number is not digits only");
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
    let access_token = secrets
        .get(ACCESS_TOKEN_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no access token is stored"))?;
    let adapter = configured_adapter(&record, &access_token, crate::network_policy::relaxed())?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(
    record: &StoredConfig,
    access_token: &str,
    allow_insecure_http: bool,
) -> Result<WhatsappCloudAdapter> {
    check_record(record)?;
    check_recipient(record.destination.trim())?;
    let access_token = access_token.trim();
    if access_token.is_empty() {
        bail!("{CODE}: the access token is empty");
    }
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    let send_url = reqwest::Url::parse(&format!("{base}/messages"))
        .with_context(|| format!("{CODE}: the endpoint does not form a message URL"))?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = WhatsappCloudAdapter {
        send_url,
        recipient: record.destination.trim().to_string(),
        access_token: access_token.to_string(),
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct WhatsappCloudAdapter {
    send_url: reqwest::Url,
    recipient: String,
    access_token: String,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for WhatsappCloudAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the whatsapp cloud client")?;
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
        runtime.block_on(self.post(client, message))
    }
}

impl WhatsappCloudAdapter {
    async fn post(&self, client: &Client, message: &OutboundMessage) -> SendResult {
        let body = json!({
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": self.recipient,
            "type": "text",
            "text": { "preview_url": false, "body": envelope_text(message) },
        });
        let answer = client
            .post(self.send_url.clone())
            .header(AUTHORIZATION, format!("Bearer {}", self.access_token))
            .header(CONTENT_TYPE, "application/json")
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
                        "the whatsapp cloud transport reported an impossible delivery",
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

/// The id Meta assigns the sent message, when the answer carries one.
fn message_id_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let messages = value.get("messages")?.as_array()?;
    let first = messages.first()?;
    let id = first.get("id")?.as_str()?.trim();
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
        .and_then(|value| value.get("error"))
        .and_then(|error| error.get("message"))
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
