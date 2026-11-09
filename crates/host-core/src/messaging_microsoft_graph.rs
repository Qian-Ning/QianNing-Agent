//! The outbound Microsoft Graph channel.
//!
//! # One hop, and a credential that is only a form post
//!
//! A channel message is `POST /v1.0/teams/{team}/channels/{channel}/messages`
//! with an application access token from the tenant's token endpoint. No
//! assertion to sign — the client-credentials grant is enough, which is why this
//! channel needs nothing from the crypto side.
//!
//! # The destination is two ids
//!
//! Graph addresses a channel by team and channel, and the record has one
//! `destination`, so it carries both: `{team-id}/{channel-id}`. Splitting there
//! is exact (neither id contains a slash) and keeps the record shape every other
//! channel uses.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-microsoft-graph",
//!   "version": 1,
//!   "endpoint": "https://graph.microsoft.com/v1.0",
//!   "destination": "00000000-team/19:abc@thread.tacv2",
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

pub(crate) const CHANNEL: &str = "microsoftGraph";

const SETTINGS_SECTION: &str = "messagingMicrosoftGraph";
const FORMAT: &str = "pi-desktop-messaging-microsoft-graph";
const FORMAT_VERSION: u32 = 1;
const TENANT_ID_SECRET_REF: &str = "secret:messaging-microsoft-graph:tenant-id";
const CLIENT_ID_SECRET_REF: &str = "secret:messaging-microsoft-graph:client-id";
const CLIENT_SECRET_SECRET_REF: &str = "secret:messaging-microsoft-graph:client-secret";

const CODE: &str = "MESSAGING_GRAPH_INVALID";
const LABEL: &str = "microsoft graph";
const SCOPE: &str = "https://graph.microsoft.com/.default";

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

/// The two ids a channel message is addressed by.
fn split_destination(destination: &str) -> Result<(String, String)> {
    let mut parts = destination.trim().splitn(2, '/');
    let team = parts.next().unwrap_or("").trim();
    let channel = parts.next().unwrap_or("").trim();
    if team.is_empty() || channel.is_empty() {
        bail!("{CODE}: the destination is not a team id and a channel id");
    }
    Ok((team.to_string(), channel.to_string()))
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
    let tenant_id = secrets
        .get(TENANT_ID_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no tenant id is stored"))?;
    let client_id = secrets
        .get(CLIENT_ID_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no client id is stored"))?;
    let client_secret = secrets
        .get(CLIENT_SECRET_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no client secret is stored"))?;
    let adapter = configured_adapter(
        &record,
        &tenant_id,
        &client_id,
        &client_secret,
        crate::network_policy::relaxed(),
    )?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(
    record: &StoredConfig,
    tenant_id: &str,
    client_id: &str,
    client_secret: &str,
    allow_insecure_http: bool,
) -> Result<GraphAdapter> {
    check_record(record)?;
    let (team, channel) = split_destination(&record.destination)?;
    let tenant_id = tenant_id.trim();
    let client_id = client_id.trim();
    let client_secret = client_secret.trim();
    if tenant_id.is_empty() || client_id.is_empty() || client_secret.is_empty() {
        bail!("{CODE}: the app registration is incomplete");
    }
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    let base = endpoint.as_str().trim_end_matches('/');
    let send_url = reqwest::Url::parse(&format!("{base}/teams/{team}/channels/{channel}/messages"))
        .with_context(|| format!("{CODE}: the endpoint does not form a message URL"))?;
    let token_url = reqwest::Url::parse(&format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
        tenant_id
    ))
    .with_context(|| format!("{CODE}: the tenant does not form a token URL"))?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = GraphAdapter {
        send_url,
        token_url,
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct GraphAdapter {
    send_url: reqwest::Url,
    token_url: reqwest::Url,
    client_id: String,
    client_secret: String,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for GraphAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the graph client")?;
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

impl GraphAdapter {
    async fn access_token(&self, client: &Client) -> TokenOutcome {
        let answer = client
            .post(self.token_url.clone())
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
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
                        "the graph token transport reported an impossible delivery",
                    )),
                }
            }
        };
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            // `invalid_client` and a missing grant are configuration, not load:
            // the same request cannot start working.
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
        match access_token_in(&body) {
            Some(token) => TokenOutcome::Minted(token),
            None => TokenOutcome::Unavailable(bounded(&format!(
                "the {LABEL} token endpoint answered {status} without a token"
            ))),
        }
    }

    async fn post(&self, client: &Client, token: &str, message: &OutboundMessage) -> SendResult {
        let body = json!({ "body": { "contentType": "text", "content": envelope_text(message) } });
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
                        "the graph transport reported an impossible delivery",
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
    let error = value.as_ref().and_then(|value| value.get("error"));
    let code = error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str);
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str);
    match (code, message) {
        (Some(code), Some(message)) => bounded(&format!(
            "the {LABEL} endpoint answered HTTP {status} ({code}: {message})"
        )),
        _ => bounded(&format!("the {LABEL} endpoint answered HTTP {status}")),
    }
}

#[cfg(test)]
mod tests;
