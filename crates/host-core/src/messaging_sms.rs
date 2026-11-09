//! The outbound SMS channel, through Twilio's Messages API.
//!
//! # One request, form-encoded
//!
//! Twilio takes `application/x-www-form-urlencoded`, not JSON, so this module
//! builds its own request instead of borrowing [`HttpChannelAdapter`]: the form
//! body, the Basic credential and the 201-with-`sid` answer are all Twilio's own
//! shapes.
//!
//! # What the record carries
//!
//! The endpoint (`https://api.twilio.com`), the recipient in E.164 form, and the
//! refs for the account SID, the auth token and the sending number. The
//! credentials never enter the record and never enter a URL: Twilio accepts them
//! as Basic auth only.
//!
//! # Refusals
//!
//! Twilio answers with real HTTP statuses, so the shared status rule decides:
//! `400` and `401` are terminal (a bad number, an unverified sender, a rotated
//! token), `429` and `5xx` are retryable.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-sms",
//!   "version": 1,
//!   "endpoint": "https://api.twilio.com",
//!   "destination": "+15551234567",
//!   "requestTimeoutMs": 10000
//! }
//! ```

use anyhow::{bail, Context, Result};
use reqwest::header::CONTENT_TYPE;
use reqwest::{Client, StatusCode};
use serde_json::Value;
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

pub(crate) const CHANNEL: &str = "sms";

const SETTINGS_SECTION: &str = "messagingSms";
const FORMAT: &str = "pi-desktop-messaging-sms";
const FORMAT_VERSION: u32 = 1;

const ACCOUNT_SID_SECRET_REF: &str = "secret:messaging-sms:account-sid";
const AUTH_TOKEN_SECRET_REF: &str = "secret:messaging-sms:auth-token";
const FROM_NUMBER_SECRET_REF: &str = "secret:messaging-sms:from-number";

const CODE: &str = "MESSAGING_SMS_INVALID";
const LABEL: &str = "sms";

/// The path Twilio's Messages resource lives under, after the account.
const ACCOUNTS_PATH: &str = "/2010-04-01/Accounts";
const MESSAGES_SUFFIX: &str = "/Messages.json";

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
            "{CODE}: unsupported sms settings record '{}'",
            record.format
        );
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: sms settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

fn send_url(
    record: &StoredConfig,
    account_sid: &str,
    allow_insecure_http: bool,
) -> Result<reqwest::Url> {
    check_record(record)?;
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    reqwest::Url::parse(&format!(
        "{base}{ACCOUNTS_PATH}/{account_sid}{MESSAGES_SUFFIX}"
    ))
    .with_context(|| format!("{CODE}: the endpoint does not form a message URL"))
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
        .with_context(|| format!("{CODE}: the sms settings could not be read"))?;
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
    let account_sid = secrets
        .get(ACCOUNT_SID_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no account SID is configured"))?;
    let auth_token = secrets
        .get(AUTH_TOKEN_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no auth token is configured"))?;
    let from_number = secrets
        .get(FROM_NUMBER_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no sending number is configured"))?;
    let adapter = configured_adapter(
        &record,
        &account_sid,
        &auth_token,
        &from_number,
        crate::network_policy::relaxed(),
    )?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(
    record: &StoredConfig,
    account_sid: &str,
    auth_token: &str,
    from_number: &str,
    allow_insecure_http: bool,
) -> Result<SmsAdapter> {
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination number is empty");
    }
    let account_sid = account_sid.trim();
    let auth_token = auth_token.trim();
    let from_number = from_number.trim();
    if account_sid.is_empty() || auth_token.is_empty() || from_number.is_empty() {
        bail!("{CODE}: the account credentials are empty");
    }
    let url = send_url(record, account_sid, allow_insecure_http)?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = SmsAdapter {
        url,
        destination: destination.to_string(),
        from_number: from_number.to_string(),
        account_sid: account_sid.to_string(),
        auth_token: auth_token.to_string(),
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct SmsAdapter {
    url: reqwest::Url,
    destination: String,
    from_number: String,
    account_sid: String,
    auth_token: String,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for SmsAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the sms client")?;
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

impl SmsAdapter {
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
        // Bound before the request: `form` borrows the text, and a temporary
        // would be dropped before the await.
        let body = envelope_text(message);
        let form = [
            ("To", self.destination.as_str()),
            ("From", self.from_number.as_str()),
            ("Body", body.as_str()),
        ];
        let answer = client
            .post(self.url.clone())
            .basic_auth(&self.account_sid, Some(&self.auth_token))
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .form(&form)
            .send()
            .await;
        let response = match answer {
            Ok(response) => response,
            Err(error) => return transport_failure(&error),
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            return SendResult::Delivered {
                remote_id: sid_in(&text),
            };
        }
        let (kind, detail) = refusal_of(status, &text);
        failed(kind, &detail)
    }
}

/// The `sid` Twilio returns for an accepted message, when it says one.
fn sid_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let sid = value.get("sid")?.as_str()?.trim();
    if sid.is_empty() {
        None
    } else {
        Some(sid.to_string())
    }
}

/// Twilio's own error text, bounded and stripped of the request it echoes.
fn refusal_of(status: StatusCode, body: &str) -> (FailureKind, String) {
    let kind = match classify_status(status, LABEL) {
        SendResult::Failed { kind, .. } => kind,
        SendResult::Delivered { .. } => FailureKind::Terminal,
    };
    let value: Option<Value> = serde_json::from_str(body).ok();
    let code = value
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(Value::as_i64);
    let message = value
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .map(|text| text.chars().take(120).collect::<String>());
    let detail = match (code, message) {
        (Some(code), Some(message)) => bounded(&format!(
            "the {LABEL} endpoint answered HTTP {status} ({code}: {message})"
        )),
        (Some(code), None) => bounded(&format!(
            "the {LABEL} endpoint answered HTTP {status} ({code})"
        )),
        _ => bounded(&format!("the {LABEL} endpoint answered HTTP {status}")),
    };
    (kind, detail)
}

fn transport_failure(error: &reqwest::Error) -> SendResult {
    match classify_transport(error, LABEL) {
        SendResult::Failed { kind, detail } => failed(kind, &detail),
        SendResult::Delivered { .. } => failed(
            FailureKind::Retryable,
            "the sms transport reported an impossible delivery",
        ),
    }
}

#[cfg(test)]
mod tests;
