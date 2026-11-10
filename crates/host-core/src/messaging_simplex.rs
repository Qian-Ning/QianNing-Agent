//! The outbound SimpleX channel.
//!
//! # Outbound is a socket too
//!
//! SimpleX has no HTTP API: the daemon owns the identity and speaks JSON over a
//! WebSocket, so this adapter opens that socket, sends one command, waits for
//! the answer with its own correlation id, and closes. Nothing is pooled — a
//! send is rare enough that a fresh connection is cheaper than the bookkeeping
//! for a shared one, and a stale socket is a failure the caller cannot see.
//!
//! # Addressing is by id
//!
//! `@<contactId>` for a direct chat and `#<groupId>` for a group. A display name
//! would be a lookup that silently resolves to nothing, which is why the record
//! stores the id the daemon prints.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-simplex",
//!   "version": 1,
//!   "endpoint": "ws://127.0.0.1:5225",
//!   "destination": "7",
//!   "requestTimeoutMs": 15000
//! }
//! ```

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

use crate::db::Database;
use crate::messaging_adapter::{
    AdapterRegistry, FailureKind, OutboundAdapter, OutboundMessage, SendResult,
};
use crate::messaging_outbound::{bounded, envelope_text, failed, request_timeout};
use crate::secrets::SecretStore;

pub(crate) const CHANNEL: &str = "simplex";

const SETTINGS_SECTION: &str = "messagingSimplex";
const FORMAT: &str = "pi-desktop-messaging-simplex";
const FORMAT_VERSION: u32 = 1;

const CODE: &str = "MESSAGING_SIMPLEX_INVALID";
const LABEL: &str = "simplex";

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

/// The daemon is local, so its socket is `ws://`; `wss://` is allowed for a
/// daemon behind a tunnel, and nothing else is.
fn check_endpoint(endpoint: &str) -> Result<SocketUri> {
    let uri: SocketUri = endpoint
        .trim()
        .parse()
        .with_context(|| format!("{CODE}: the endpoint is not a URL"))?;
    match uri.scheme_str() {
        Some("ws") | Some("wss") => {}
        other => bail!(
            "{CODE}: the endpoint scheme '{}' is not ws or wss",
            other.unwrap_or("")
        ),
    }
    if uri.host().unwrap_or("").is_empty() {
        bail!("{CODE}: the endpoint names no host");
    }
    Ok(uri)
}

/// The socket URL type: `reqwest::Url` rejects `ws://`, and this channel's
/// endpoint is a websocket by definition.
type SocketUri = tokio_tungstenite::tungstenite::http::Uri;

/// `@<id>` for a direct chat, `#<id>` for a group.
fn target_of(destination: &str) -> Result<String> {
    let destination = destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination chat is empty");
    }
    if let Some(group) = destination.strip_prefix("group:") {
        if group.is_empty() || !group.chars().all(|c| c.is_ascii_digit()) {
            bail!("{CODE}: the group id is not a number");
        }
        return Ok(format!("#{group}"));
    }
    if !destination.chars().all(|c| c.is_ascii_digit()) {
        bail!("{CODE}: the contact id is not a number");
    }
    Ok(format!("@{destination}"))
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
    _secrets: &SecretStore,
) -> Result<()> {
    let Some(record) = stored_record(db)? else {
        return Ok(());
    };
    // No credential: the socket is local and the daemon has no password.
    let adapter = configured_adapter(&record)?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(record: &StoredConfig) -> Result<SimplexAdapter> {
    check_record(record)?;
    let endpoint = check_endpoint(&record.endpoint)?;
    let target = target_of(&record.destination)?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    Ok(SimplexAdapter {
        url: endpoint.to_string(),
        target,
        timeout,
    })
}

struct SimplexAdapter {
    url: String,
    target: String,
    timeout: Duration,
}

impl OutboundAdapter for SimplexAdapter {
    fn connect(&mut self) -> Result<()> {
        Ok(())
    }

    fn disconnect(&mut self) -> Result<()> {
        Ok(())
    }

    fn send(&self, message: &OutboundMessage) -> SendResult {
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
        runtime.block_on(self.deliver(message))
    }
}

impl SimplexAdapter {
    async fn deliver(&self, message: &OutboundMessage) -> SendResult {
        let corr = format!("pi-{}", message.id);
        let item = json!({
            "msgContent": { "type": "text", "text": envelope_text(message) },
            "mentions": {},
        });
        let command = format!(
            "/_send {} json {}",
            self.target,
            serde_json::to_string(&vec![item]).unwrap_or_else(|_| "[]".into())
        );

        let connect =
            tokio::time::timeout(self.timeout, tokio_tungstenite::connect_async(&self.url)).await;
        let mut socket = match connect {
            Ok(Ok((socket, _))) => socket,
            Ok(Err(error)) => {
                return failed(
                    FailureKind::Retryable,
                    &bounded(&format!("the {LABEL} daemon could not be reached: {error}")),
                )
            }
            Err(_) => {
                return failed(
                    FailureKind::Retryable,
                    &bounded(&format!("the {LABEL} daemon did not answer in time")),
                )
            }
        };

        // `/_start` first: the daemon accepts commands without it, but sending it
        // keeps this path identical to the inbound one and avoids a protocol
        // state the two sides disagree about.
        let _ = socket
            .send(Message::Text(
                r#"{"corrId":"pi-send-start","cmd":"/_start"}"#.into(),
            ))
            .await;
        let frame = json!({ "corrId": corr, "cmd": command });
        if let Err(error) = socket.send(Message::Text(frame.to_string())).await {
            return failed(
                FailureKind::Retryable,
                &bounded(&format!("the {LABEL} command could not be sent: {error}")),
            );
        }

        let deadline = tokio::time::Instant::now() + self.timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                let _ = socket.close(None).await;
                return failed(
                    FailureKind::Retryable,
                    &bounded(&format!(
                        "the {LABEL} daemon did not confirm the send in time"
                    )),
                );
            }
            let next = tokio::time::timeout(remaining, socket.next()).await;
            let frame = match next {
                Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
                // A close is handled before the catch-all, so it can report why.
                Ok(Some(Ok(Message::Close(_)))) | Ok(None) => {
                    return failed(
                        FailureKind::Retryable,
                        &bounded(&format!(
                            "the {LABEL} daemon closed before confirming the send"
                        )),
                    )
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(error))) => {
                    return failed(
                        FailureKind::Retryable,
                        &bounded(&format!("the {LABEL} socket failed: {error}")),
                    )
                }
                Err(_) => {
                    let _ = socket.close(None).await;
                    return failed(
                        FailureKind::Retryable,
                        &bounded(&format!(
                            "the {LABEL} daemon did not confirm the send in time"
                        )),
                    );
                }
            };
            let Some(outcome) = classify_answer(&frame, &corr_id_of(&message.id)) else {
                continue;
            };
            let _ = socket.close(None).await;
            return outcome;
        }
    }
}

fn corr_id_of(id: &str) -> String {
    format!("pi-{id}")
}

/// Read one daemon answer; `None` means "not ours, keep reading".
fn classify_answer(frame: &str, corr: &str) -> Option<SendResult> {
    let value: Value = serde_json::from_str(frame).ok()?;
    if value.get("corrId").and_then(Value::as_str) != Some(corr) {
        return None;
    }
    let resp = value.get("resp")?;
    let kind = resp.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "sentMessages" => Some(SendResult::Delivered {
            remote_id: resp
                .get("sentMessages")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("id"))
                .and_then(Value::as_i64)
                .map(|id| id.to_string()),
        }),
        // Every refusal the daemon can make arrives as a typed error; a wrong
        // contact id is not going to become right on a retry.
        "chatCmdError" | "commandError" => {
            let detail = resp
                .get("chatError")
                .and_then(|error| error.get("errorType"))
                .and_then(|error| error.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("refused");
            Some(failed(
                FailureKind::Terminal,
                &bounded(&format!("the {LABEL} daemon answered: {detail}")),
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
