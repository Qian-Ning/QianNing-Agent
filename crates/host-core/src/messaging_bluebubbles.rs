//! The outbound BlueBubbles channel.
//!
//! # A bridge, not a platform
//!
//! BlueBubbles is a server running on a Mac signed into Messages; this module
//! posts to its documented REST API. That is the arrangement every non-macOS
//! iMessage client uses, and it is why the record's endpoint is the bridge's
//! own address rather than an Apple host.
//!
//! # The password is a query parameter
//!
//! `POST /api/v1/message/text?guid=<password>` — the same value the webhook
//! carries. It goes in the query string because that is where the bridge reads
//! it, and the URL is never logged.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-bluebubbles",
//!   "version": 1,
//!   "endpoint": "http://192.168.1.20:1234",
//!   "destination": "iMessage;-;+15551234567",
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

pub(crate) const CHANNEL: &str = "blueBubbles";

const SETTINGS_SECTION: &str = "messagingBluebubbles";
const FORMAT: &str = "pi-desktop-messaging-bluebubbles";
const FORMAT_VERSION: u32 = 1;
const PASSWORD_SECRET_REF: &str = "secret:messaging-bluebubbles:password";

const CODE: &str = "MESSAGING_BLUEBUBBLES_INVALID";
const LABEL: &str = "bluebubbles";

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
    let password = secrets
        .get(PASSWORD_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no server password is stored"))?;
    let adapter = configured_adapter(&record, &password, crate::network_policy::relaxed())?;
    registry.register(CHANNEL, Box::new(adapter))
}

/// The bridge usually runs on the LAN, so plain HTTP is allowed for a private
/// address and https for anything else — the same rule the other local channels
/// use.
fn configured_adapter(
    record: &StoredConfig,
    password: &str,
    allow_insecure_http: bool,
) -> Result<BluebubblesAdapter> {
    check_record(record)?;
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination chat is empty");
    }
    let password = password.trim();
    if password.is_empty() {
        bail!("{CODE}: the server password is empty");
    }
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    let send_url = reqwest::Url::parse_with_params(
        &format!("{base}/api/v1/message/text"),
        &[("guid", password)],
    )
    .with_context(|| format!("{CODE}: the endpoint does not form a message URL"))?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = BluebubblesAdapter {
        send_url,
        destination: destination.to_string(),
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct BluebubblesAdapter {
    send_url: reqwest::Url,
    destination: String,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for BluebubblesAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the bluebubbles client")?;
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

impl BluebubblesAdapter {
    async fn post(&self, client: &Client, message: &OutboundMessage) -> SendResult {
        // A chat guid addresses either a direct chat or a group; otherwise the
        // bridge accepts a bare address and resolves the chat itself.
        let addresses: Vec<String> =
            if self.destination.contains(";-;") || self.destination.contains(";+;") {
                Vec::new()
            } else {
                vec![self.destination.clone()]
            };
        let mut body = json!({
            "message": envelope_text(message),
            "tempGuid": format!("temp-{}", message.id),
            "method": "apple-script",
        });
        if addresses.is_empty() {
            body["chatGuid"] = json!(self.destination);
        } else {
            body["addresses"] = json!(addresses);
        }

        let answer = client
            .post(self.send_url.clone())
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
                        "the bluebubbles transport reported an impossible delivery",
                    ),
                }
            }
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            return SendResult::Delivered {
                remote_id: message_guid_in(&text),
            };
        }
        let kind = match classify_status(status, LABEL) {
            SendResult::Failed { kind, .. } => kind,
            SendResult::Delivered { .. } => FailureKind::Terminal,
        };
        failed(kind, &refusal_detail(status, &text))
    }
}

/// The bridge wraps every answer in `{status, message, data}`.
fn message_guid_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let data = value.get("data")?;
    let guid = match data {
        Value::Object(map) => map.get("guid")?.as_str()?.trim().to_string(),
        Value::Array(items) => items.first()?.get("guid")?.as_str()?.trim().to_string(),
        _ => return None,
    };
    if guid.is_empty() {
        None
    } else {
        Some(guid)
    }
}

fn refusal_detail(status: StatusCode, body: &str) -> String {
    let value: Option<Value> = serde_json::from_str(body).ok();
    let error = value.as_ref().and_then(|value| value.get("error"));
    let message = error
        .and_then(|error| error.get("error"))
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .as_ref()
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
        })
        .map(|text| text.chars().take(120).collect::<String>());
    match message {
        Some(message) => bounded(&format!(
            "the {LABEL} bridge answered HTTP {status} ({message})"
        )),
        None => bounded(&format!("the {LABEL} bridge answered HTTP {status}")),
    }
}

#[cfg(test)]
mod tests;
