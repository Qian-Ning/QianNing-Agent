//! The outbound Google Chat channel.
//!
//! # Two credentials, neither of them ours
//!
//! Google Chat does not take a static API key. Sending needs an OAuth2 access
//! token, and the only way to get one for a service account is to sign a JWT
//! assertion with the account's private key and exchange it. That is what this
//! module does: RS256 over `{iss, scope, aud, exp, iat}`, posted to the account's
//! own token endpoint, then one `messages.create` call.
//!
//! The receiving direction is the mirror image — Google signs an assertion *to*
//! us — and lives in `packages/agent-host/src/messaging-google-chat-inbound.ts`.
//!
//! # The key stays in the secret store
//!
//! The record carries the endpoint and the space; the service account JSON is a
//! secret. It is parsed here, and the private key never enters a URL, a log line
//! or a failure detail.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-google-chat",
//!   "version": 1,
//!   "endpoint": "https://chat.googleapis.com",
//!   "destination": "spaces/AAAA1111",
//!   "requestTimeoutMs": 10000
//! }
//! ```

use anyhow::{bail, Context, Result};
use base64::Engine;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use ring::rand::SystemRandom;
use ring::signature::{RsaKeyPair, RSA_PKCS1_SHA256};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::db::Database;
use crate::messaging_adapter::{
    AdapterRegistry, FailureKind, OutboundAdapter, OutboundMessage, SendResult,
};
use crate::messaging_outbound::{
    bounded, classify_status, classify_transport, envelope_text, failed, request_timeout,
    validate_https_endpoint,
};
use crate::secrets::SecretStore;

pub(crate) const CHANNEL: &str = "googleChat";

const SETTINGS_SECTION: &str = "messagingGoogleChat";
const FORMAT: &str = "pi-desktop-messaging-google-chat";
const FORMAT_VERSION: u32 = 1;
const SERVICE_ACCOUNT_SECRET_REF: &str = "secret:messaging-google-chat:service-account";

const CODE: &str = "MESSAGING_GOOGLE_CHAT_INVALID";
const LABEL: &str = "google chat";

/// The scope a Chat app needs to post as itself.
const SCOPE: &str = "https://www.googleapis.com/auth/chat.bot";
/// The API path; the space name is appended.
const SPACES_PATH: &str = "/v1/";

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

fn base_url(record: &StoredConfig, allow_insecure_http: bool) -> Result<String> {
    check_record(record)?;
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    Ok(endpoint.as_str().trim_end_matches('/').to_string())
}

/// The parts of a service account this module needs.
struct ServiceAccount {
    client_email: String,
    /// PKCS#8 DER, decoded from the PEM the console hands out.
    private_key: Vec<u8>,
    token_uri: String,
}

/// Parse the service account JSON, refusing anything incomplete.
fn parse_service_account(raw: &str) -> Result<ServiceAccount> {
    let value: Value = serde_json::from_str(raw)
        .with_context(|| format!("{CODE}: the service account is not JSON"))?;
    let client_email = value
        .get("client_email")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let private_key = value
        .get("private_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let token_uri = value
        .get("token_uri")
        .and_then(Value::as_str)
        .unwrap_or("https://oauth2.googleapis.com/token")
        .trim()
        .to_string();
    if client_email.is_empty() || private_key.is_empty() {
        bail!("{CODE}: the service account has no client_email or private_key");
    }
    let der = pem_to_der(&private_key)?;
    Ok(ServiceAccount {
        client_email,
        private_key: der,
        token_uri,
    })
}

/// Strip a PEM envelope and decode its body.
fn pem_to_der(pem: &str) -> Result<Vec<u8>> {
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<Vec<&str>>()
        .join("");
    if body.is_empty() {
        bail!("{CODE}: the private key is empty");
    }
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| anyhow::anyhow!("{CODE}: the private key is not base64"))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The signed assertion a token exchange needs.
fn signed_assertion(account: &ServiceAccount) -> Result<String> {
    let header = json!({ "alg": "RS256", "typ": "JWT" });
    let issued = now_seconds();
    let claims = json!({
        "iss": account.client_email,
        "scope": SCOPE,
        "aud": account.token_uri,
        "iat": issued,
        "exp": issued + 3_600,
    });
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let signing_input = format!(
        "{}.{}",
        engine.encode(header.to_string()),
        engine.encode(claims.to_string())
    );

    let key = RsaKeyPair::from_pkcs8(&account.private_key)
        .map_err(|_| anyhow::anyhow!("{CODE}: the private key is not a usable RSA key"))?;
    let mut signature = vec![0u8; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        signing_input.as_bytes(),
        &mut signature,
    )
    .map_err(|_| anyhow::anyhow!("{CODE}: the assertion could not be signed"))?;
    Ok(format!("{signing_input}.{}", engine.encode(&signature)))
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
    let raw = secrets
        .get(SERVICE_ACCOUNT_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no service account is stored"))?;
    let adapter = configured_adapter(&record, &raw, crate::network_policy::relaxed())?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(
    record: &StoredConfig,
    service_account: &str,
    allow_insecure_http: bool,
) -> Result<GoogleChatAdapter> {
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination space is empty");
    }
    let account = parse_service_account(service_account)?;
    let base = base_url(record, allow_insecure_http)?;
    let send_url = reqwest::Url::parse(&format!("{base}{SPACES_PATH}{destination}/messages"))
        .with_context(|| format!("{CODE}: the endpoint does not form a message URL"))?;
    let token_url = reqwest::Url::parse(&account.token_uri)
        .with_context(|| format!("{CODE}: the service account names an unusable token URL"))?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let mut adapter = GoogleChatAdapter {
        send_url,
        token_url,
        account,
        timeout,
        client: None,
    };
    adapter.connect()?;
    Ok(adapter)
}

struct GoogleChatAdapter {
    send_url: reqwest::Url,
    token_url: reqwest::Url,
    account: ServiceAccount,
    timeout: Duration,
    client: Option<Client>,
}

impl OutboundAdapter for GoogleChatAdapter {
    fn connect(&mut self) -> Result<()> {
        if self.client.is_some() {
            return Ok(());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(self.timeout)
            .build()
            .context("build the google chat client")?;
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

impl GoogleChatAdapter {
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
        let token = match runtime.block_on(self.access_token(client)) {
            TokenOutcome::Minted(token) => token,
            TokenOutcome::Refused(detail) => return failed(FailureKind::Terminal, &detail),
            TokenOutcome::Unavailable(detail) => return failed(FailureKind::Retryable, &detail),
        };
        runtime.block_on(self.post(client, &token, message))
    }

    /// Exchange the signed assertion for an access token.
    async fn access_token(&self, client: &Client) -> TokenOutcome {
        let assertion = match signed_assertion(&self.account) {
            Ok(assertion) => assertion,
            Err(error) => return TokenOutcome::Refused(bounded(&error.to_string())),
        };
        let answer = client
            .post(self.token_url.clone())
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await;
        let response = match answer {
            Ok(response) => response,
            Err(error) => return token_transport_outcome(&error),
        };
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return TokenOutcome::Refused(bounded(&format!(
                "the {LABEL} token endpoint answered HTTP {status}"
            )));
        }
        match access_token_in(&body) {
            Some(token) => TokenOutcome::Minted(token),
            None => TokenOutcome::Unavailable(bounded(&format!(
                "the {LABEL} token endpoint answered {status} without a token"
            ))),
        }
    }

    async fn post(&self, client: &Client, token: &str, message: &OutboundMessage) -> SendResult {
        let body = json!({ "text": envelope_text(message) });
        let answer = client
            .post(self.send_url.clone())
            .header(AUTHORIZATION, format!("Bearer {token}"))
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
        if status.is_success() {
            return SendResult::Delivered {
                remote_id: message_name_in(&text),
            };
        }
        let kind = match classify_status(status, LABEL) {
            SendResult::Failed { kind, .. } => kind,
            SendResult::Delivered { .. } => FailureKind::Terminal,
        };
        failed(kind, &refusal_detail(status, &text))
    }
}

enum TokenOutcome {
    Minted(String),
    Refused(String),
    Unavailable(String),
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

fn message_name_in(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let name = value.get("name")?.as_str()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
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

fn transport_failure(error: &reqwest::Error) -> SendResult {
    match classify_transport(error, LABEL) {
        SendResult::Failed { kind, detail } => failed(kind, &detail),
        SendResult::Delivered { .. } => failed(
            FailureKind::Retryable,
            "the google chat transport reported an impossible delivery",
        ),
    }
}

fn token_transport_outcome(error: &reqwest::Error) -> TokenOutcome {
    match classify_transport(error, LABEL) {
        SendResult::Failed { detail, .. } => TokenOutcome::Unavailable(detail),
        SendResult::Delivered { .. } => TokenOutcome::Unavailable(bounded(
            "the google chat transport reported an impossible token exchange",
        )),
    }
}

#[cfg(test)]
mod tests;
