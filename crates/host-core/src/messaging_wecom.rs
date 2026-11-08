//! The outbound WeCom (企业微信) channel: a message from the app to one user.
//!
//! # Why this is not `HttpChannelAdapter`
//!
//! WeCom authenticates a send with an `access_token` minted from the corp id and
//! the app's secret, and that token dies after two hours while a Host may run
//! for days. It is minted per attempt, exactly as DingTalk's and Feishu's are.
//!
//! # Two shapes worth knowing
//!
//! * The token is fetched with a **GET** whose query carries the corp id and
//!   secret. That is unusual and it is the platform's own design; the secret
//!   therefore appears in a URL, which is why the endpoint is validated as HTTPS
//!   before it is ever built.
//! * A refusal is HTTP 200 with a non-zero `errcode`, so the body decides, not
//!   the status. Reading only the status would record a refusal as a delivery.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-wecom",
//!   "version": 1,
//!   "endpoint": "https://qyapi.weixin.qq.com",
//!   "destination": "<user id, or @all>",
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
pub(crate) const CHANNEL: &str = "wecom";

/// The settings section the record lives in.
const SETTINGS_SECTION: &str = "messagingWecom";
const FORMAT: &str = "pi-desktop-messaging-wecom";
const FORMAT_VERSION: u32 = 1;

/// Where the three credentials live.
const CORP_ID_SECRET_REF: &str = "secret:messaging-wecom:corp-id";
const CORP_SECRET_SECRET_REF: &str = "secret:messaging-wecom:corp-secret";
const AGENT_ID_SECRET_REF: &str = "secret:messaging-wecom:agent-id";

const CODE: &str = "MESSAGING_WECOM_INVALID";
const LABEL: &str = "wecom";

/// The token endpoint, appended to the configured origin.
const TOKEN_PATH: &str = "/cgi-bin/gettoken";
/// The send method, appended to the configured origin.
const SEND_PATH: &str = "/cgi-bin/message/send";

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
            "{CODE}: unsupported wecom settings record '{}'",
            record.format
        );
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: wecom settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

/// One address on the configured origin, built by string so a proxy base path
/// survives.
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
        .with_context(|| format!("{CODE}: the wecom settings could not be read"))?;
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
    let corp_id = secrets
        .get(CORP_ID_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no corp id is configured"))?;
    let corp_secret = secrets
        .get(CORP_SECRET_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no corp secret is configured"))?;
    let agent_id = secrets
        .get(AGENT_ID_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no agent id is configured"))?;
    let adapter = configured_adapter(
        &record,
        &corp_id,
        &corp_secret,
        &agent_id,
        crate::network_policy::relaxed(),
    )?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(
    record: &StoredConfig,
    corp_id: &str,
    corp_secret: &str,
    agent_id: &str,
    allow_insecure_http: bool,
) -> Result<WecomAdapter> {
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination user is empty");
    }
    let corp_id = corp_id.trim();
    let corp_secret = corp_secret.trim();
    let agent_id = agent_id.trim();
    if corp_id.is_empty() || corp_secret.is_empty() {
        bail!("{CODE}: the corp credentials are empty");
    }
    let agent: i64 = agent_id
        .parse()
        .map_err(|_| anyhow::anyhow!("{CODE}: the agent id is not a number"))?;
    let token_url = platform_url(record, allow_insecure_http, TOKEN_PATH)?;
    let send_url = platform_url(record, allow_insecure_http, SEND_PATH)?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = WecomAdapter {
        token_url,
        send_url,
        destination: destination.to_string(),
        corp_id: corp_id.to_string(),
        corp_secret: corp_secret.to_string(),
        agent_id: agent,
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct WecomAdapter {
    token_url: reqwest::Url,
    send_url: reqwest::Url,
    destination: String,
    corp_id: String,
    corp_secret: String,
    agent_id: i64,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for WecomAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the wecom channel client")?;
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

impl WecomAdapter {
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
                )
            }
        };
        let token = match runtime.block_on(self.exchange_token(client)) {
            TokenOutcome::Minted(token) => token,
            TokenOutcome::Refused(detail) => return failed(FailureKind::Terminal, &detail),
            TokenOutcome::Unavailable(detail) => return failed(FailureKind::Retryable, &detail),
        };
        runtime.block_on(self.post(client, &token, message))
    }

    /// The token is minted with a GET whose query carries the corp id and secret.
    async fn exchange_token(&self, client: &Client) -> TokenOutcome {
        let answer = client
            .get(self.token_url.clone())
            .query(&[
                ("corpid", self.corp_id.as_str()),
                ("corpsecret", self.corp_secret.as_str()),
            ])
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
        if let Some(code) = errcode(&body) {
            if code != 0 {
                return match classify_errcode(code) {
                    FailureKind::Terminal => TokenOutcome::Refused(refusal_detail(&body)),
                    FailureKind::Retryable => TokenOutcome::Unavailable(refusal_detail(&body)),
                };
            }
        }
        match access_token_in(&body) {
            Some(token) => TokenOutcome::Minted(token),
            None => TokenOutcome::Unavailable(bounded(&format!(
                "the {LABEL} token endpoint answered {status} without an access token"
            ))),
        }
    }

    async fn post(&self, client: &Client, token: &str, message: &OutboundMessage) -> SendResult {
        let body = json!({
            "touser": self.destination,
            "msgtype": "text",
            "agentid": self.agent_id,
            "text": { "content": envelope_text(message) },
        });
        let answer = client
            .post(self.send_url.clone())
            .query(&[("access_token", token)])
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

fn access_token_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let token = value.get("access_token")?.as_str()?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

enum TokenOutcome {
    Minted(String),
    Refused(String),
    Unavailable(String),
}

fn errcode(body: &str) -> Option<i64> {
    let value: Value = serde_json::from_str(body).ok()?;
    value.get("errcode").and_then(Value::as_i64)
}

/// WeCom's codes that mean the credentials themselves are wrong.
const CREDENTIAL_CODES: [i64; 3] = [40013, 40001, 40056];

/// WeCom's throttles and transient faults.
const RETRYABLE_CODES: [i64; 3] = [45009, 45033, 42001];

fn classify_errcode(code: i64) -> FailureKind {
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
            "the {LABEL} call was refused (errcode {code}: {message})"
        )),
        (Some(code), None) => bounded(&format!("the {LABEL} call was refused (errcode {code})")),
        _ => bounded(&format!("the {LABEL} call was refused")),
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
            "the wecom transport reported an impossible delivery",
        ),
    }
}

fn transport_outcome(error: &reqwest::Error) -> TokenOutcome {
    match classify_transport(error, LABEL) {
        SendResult::Failed {
            kind: FailureKind::Terminal,
            detail,
        } => TokenOutcome::Refused(detail),
        SendResult::Failed { detail, .. } => TokenOutcome::Unavailable(detail),
        SendResult::Delivered { .. } => TokenOutcome::Unavailable(bounded(
            "the wecom transport reported an impossible token exchange",
        )),
    }
}

fn refusal_outcome(status: StatusCode, body: &str) -> TokenOutcome {
    if let Some(code) = errcode(body) {
        if code != 0 {
            let detail = refusal_detail(body);
            return match classify_errcode(code) {
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
