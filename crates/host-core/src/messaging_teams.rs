//! The outbound Microsoft Teams channel.
//!
//! # Two hops, like Google Chat, but no signing
//!
//! Teams sends are addressed to the *Connector*, not to the tenant: the bot's
//! `serviceUrl` plus `/v3/conversations/{conversationId}/activities`. The
//! Connector wants an Azure AD access token, and the bot credential grant is a
//! plain form post — no assertion, no key. That makes this channel simpler than
//! Google Chat despite doing the same two-hop shape.
//!
//! # Why the service URL is the endpoint
//!
//! The Connector's host is per-tenant (`smba.trafficmanager.net/emea/`,
//! `/apac/`, a sovereign-cloud host, …). The record stores that base as
//! `endpoint` and the conversation as `destination`, which is exactly what the
//! inbound activity's `serviceUrl` and `conversation.id` carry — so an activity
//! can be turned into a record without guessing.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-teams",
//!   "version": 1,
//!   "endpoint": "https://smba.trafficmanager.net/emea/",
//!   "destination": "a:1abcdefghijklmnop",
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

pub(crate) const CHANNEL: &str = "teams";

const SETTINGS_SECTION: &str = "messagingTeams";
const FORMAT: &str = "pi-desktop-messaging-teams";
const FORMAT_VERSION: u32 = 1;
const APP_ID_SECRET_REF: &str = "secret:messaging-teams:app-id";
const APP_PASSWORD_SECRET_REF: &str = "secret:messaging-teams:app-password";

/// The bot credential grant: a fixed host, not the tenant's.
const TOKEN_URL: &str = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const SCOPE: &str = "https://api.botframework.com/.default";

const CODE: &str = "MESSAGING_TEAMS_INVALID";
const LABEL: &str = "teams";

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

/// A conversation id goes into a path segment as written: Teams ids contain `:`
/// and `;`, both legal there, but a slash or a query separator would change
/// which resource is addressed.
fn check_conversation_id(id: &str) -> Result<()> {
    if id.is_empty() {
        bail!("{CODE}: the destination conversation is empty");
    }
    if id.contains('/') || id.contains('?') || id.contains('#') {
        bail!("{CODE}: the destination conversation is not a single path segment");
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
    let app_password = secrets
        .get(APP_PASSWORD_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no app password is stored"))?;
    let adapter = configured_adapter(
        &record,
        &app_id,
        &app_password,
        crate::network_policy::relaxed(),
    )?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(
    record: &StoredConfig,
    app_id: &str,
    app_password: &str,
    allow_insecure_http: bool,
) -> Result<TeamsAdapter> {
    check_record(record)?;
    check_conversation_id(record.destination.trim())?;
    let app_id = app_id.trim();
    let app_password = app_password.trim();
    if app_id.is_empty() || app_password.is_empty() {
        bail!("{CODE}: the app registration is incomplete");
    }
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    let send_url = reqwest::Url::parse(&format!(
        "{base}/v3/conversations/{}/activities",
        record.destination.trim()
    ))
    .with_context(|| format!("{CODE}: the endpoint does not form an activity URL"))?;
    let token_url = reqwest::Url::parse(TOKEN_URL).context("parse the bot framework token URL")?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = TeamsAdapter {
        send_url,
        token_url,
        app_id: app_id.to_string(),
        app_password: app_password.to_string(),
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct TeamsAdapter {
    send_url: reqwest::Url,
    token_url: reqwest::Url,
    app_id: String,
    app_password: String,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for TeamsAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the teams client")?;
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

impl TeamsAdapter {
    async fn access_token(&self, client: &Client) -> TokenOutcome {
        let answer = client
            .post(self.token_url.clone())
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.app_id.as_str()),
                ("client_secret", self.app_password.as_str()),
                ("scope", SCOPE),
            ])
            .send()
            .await;
        let response = match answer {
            Ok(response) => response,
            Err(error) => {
                return match classify_transport(&error, LABEL) {
                    SendResult::Failed { detail, .. } => TokenOutcome::Unavailable(detail),
                    SendResult::Delivered { .. } => TokenOutcome::Unavailable(bounded(
                        "the teams token transport reported an impossible delivery",
                    )),
                }
            }
        };
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            // A wrong secret is a terminal answer: retrying the same credentials
            // cannot start working, and it burns the tenant's sign-in log.
            let kind = match status {
                StatusCode::UNAUTHORIZED | StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN => {
                    TokenOutcome::Refused(bounded(&format!(
                        "the {LABEL} token endpoint refused the app registration (HTTP {status})"
                    )))
                }
                _ => TokenOutcome::Unavailable(bounded(&format!(
                    "the {LABEL} token endpoint answered HTTP {status}"
                ))),
            };
            return kind;
        }
        match access_token_in(&body) {
            Some(token) => TokenOutcome::Minted(token),
            None => TokenOutcome::Unavailable(bounded(&format!(
                "the {LABEL} token endpoint answered {status} without a token"
            ))),
        }
    }

    async fn post(&self, client: &Client, token: &str, message: &OutboundMessage) -> SendResult {
        let body = json!({ "type": "message", "text": envelope_text(message) });
        let answer = client
            .post(self.send_url.clone())
            .header(AUTHORIZATION, format!("Bearer {token}"))
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
                        "the teams transport reported an impossible delivery",
                    ),
                }
            }
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            return SendResult::Delivered {
                remote_id: activity_id_in(&text),
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

fn activity_id_in(body: &str) -> Option<String> {
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
