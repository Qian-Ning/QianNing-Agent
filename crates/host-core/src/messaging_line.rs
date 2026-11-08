//! The outbound LINE channel.
//!
//! Delivers the same redacted summary the other channels carry, through LINE's
//! Messaging API push endpoint. It follows Discord's structure: one JSON POST per
//! attempt, the shared transport doing the work, and the status deciding the
//! ledger's fate.
//!
//! # Two credentials, two directions
//!
//! Sending authenticates with the **channel access token** (`Authorization:
//! Bearer …`), which never expires and never appears in a URL. Receiving is
//! authenticated by the **channel secret**, an HMAC over the raw body, and lives
//! in `packages/agent-host/src/messaging-line-inbound.ts` because it is an HTTP
//! surface rather than a transport this module owns.
//!
//! # Why the body is nested
//!
//! LINE takes `{"to": …, "messages": [{"type":"text","text":…}]}`: a push is a
//! batch of messages, not a single string. One message per delivery keeps the
//! summary readable and stays well inside the platform's five-message cap.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-line",
//!   "version": 1,
//!   "endpoint": "https://api.line.me",
//!   "destination": "<user, group or room id>",
//!   "requestTimeoutMs": 10000
//! }
//! ```

use anyhow::{bail, Context, Result};

use crate::db::Database;
use crate::messaging_adapter::{AdapterRegistry, OutboundAdapter};
use crate::messaging_outbound::{
    authorization_header, envelope_text, request_timeout, validate_https_endpoint, BodyBuilder,
    ChannelConfig, HttpChannelAdapter,
};
use crate::secrets::SecretStore;

/// The delivery channel this adapter serves and the name it registers under.
pub(crate) const CHANNEL: &str = "line";

/// The settings section the record lives in.
const SETTINGS_SECTION: &str = "messagingLine";
const FORMAT: &str = "pi-desktop-messaging-line";
const FORMAT_VERSION: u32 = 1;

/// Where the send credential lives.
const CHANNEL_TOKEN_SECRET_REF: &str = "secret:messaging-line:channel-token";

const CODE: &str = "MESSAGING_LINE_INVALID";
const LABEL: &str = "line";

/// The push endpoint, appended to the configured origin.
const SEND_PATH: &str = "/v2/bot/message/push";
/// The scheme the platform's own documentation specifies.
const AUTHORIZATION_SCHEME: &str = "Bearer";

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
        bail!(
            "{CODE}: unsupported line settings record '{}'",
            record.format
        );
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: line settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

fn send_url(record: &StoredConfig, allow_insecure_http: bool) -> Result<reqwest::Url> {
    check_record(record)?;
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    reqwest::Url::parse(&format!("{base}{SEND_PATH}"))
        .with_context(|| format!("{CODE}: the endpoint does not form a {SEND_PATH} URL"))
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
        .with_context(|| format!("{CODE}: the line settings could not be read"))?;
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
    let token = secrets
        .get(CHANNEL_TOKEN_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no channel access token is configured"))?;
    let adapter = configured_adapter(&record, &token, crate::network_policy::relaxed())?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(
    record: &StoredConfig,
    token: &str,
    allow_insecure_http: bool,
) -> Result<HttpChannelAdapter> {
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination conversation is empty");
    }
    let url = send_url(record, allow_insecure_http)?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let authorization = Some(authorization_header(
        AUTHORIZATION_SCHEME,
        token,
        CODE,
        "channel access token",
    )?);
    let to = destination.to_string();
    let body: BodyBuilder = Box::new(move |message| {
        serde_json::json!({
            "to": to,
            "messages": [{ "type": "text", "text": envelope_text(message) }],
        })
    });
    let config = ChannelConfig::new(url, authorization, timeout, body);
    let mut adapter = HttpChannelAdapter::new(LABEL).configure(config);
    adapter.connect()?;
    Ok(adapter)
}

#[cfg(test)]
mod tests;
