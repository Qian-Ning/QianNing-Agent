//! The outbound Buzz channel.
//!
//! # Buzz is a Nostr relay
//!
//! There is no REST endpoint to post to. A message is a signed event published
//! over a websocket: `["EVENT", {"kind":9,"tags":[["h","<channel>"]],…}]`, and
//! the relay answers `["OK", <id>, true]`. The relay may first send an `AUTH`
//! challenge (NIP-42), which is answered with a signed kind-22242 event that
//! names the relay and the challenge — without it a relay that requires auth
//! refuses the publish.
//!
//! # What this module owns
//!
//! The event: its canonical serialization (the id is the SHA-256 of
//! `[0,pubkey,created_at,kind,tags,content]`), its BIP340 signature, and the
//! two-step handshake. Nothing else — the channel's queue, retries and failure
//! classification are the adapter's, as for every other channel.
//!
//! # Configuration
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-buzz",
//!   "version": 1,
//!   "endpoint": "wss://buzz.example.com",
//!   "destination": "<channel uuid>",
//!   "requestTimeoutMs": 15000
//! }
//! ```
//!
//! The private key is `secret:messaging-buzz:private-key`, in `nsec` or as 64
//! hex characters.

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

use crate::db::Database;
use crate::messaging_adapter::{AdapterRegistry, FailureKind, OutboundAdapter, OutboundMessage, SendResult};
use crate::messaging_outbound::{bounded, envelope_text, failed, request_timeout};
use crate::secrets::SecretStore;

pub(crate) const CHANNEL: &str = "buzz";

const SETTINGS_SECTION: &str = "messagingBuzz";
const FORMAT: &str = "pi-desktop-messaging-buzz";
const FORMAT_VERSION: u32 = 1;

const CODE: &str = "MESSAGING_BUZZ_INVALID";
const LABEL: &str = "buzz";

/// The key the Host stores the Nostr private key under.
pub(crate) const PRIVATE_KEY_SECRET_REF: &str = "messaging-buzz:private-key";

/// A group message. Buzz's channels are NIP-29 groups and their chat events are
/// kind 9, tagged with the channel's id under `h`.
const GROUP_MESSAGE_KIND: u64 = 9;

/// The NIP-42 authentication event kind.
const AUTH_KIND: u64 = 22242;

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

/// The relay is reached over a websocket; `ws://` is allowed for a relay on this
/// machine, `wss://` for one that is not.
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

type SocketUri = tokio_tungstenite::tungstenite::http::Uri;

/// The channel id: a UUID as the relay names it, which is what the `h` tag
/// carries. A name would be a lookup that silently resolves to nothing.
fn channel_of(destination: &str) -> Result<String> {
    let destination = destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination channel is empty");
    }
    if destination.chars().any(|c| c.is_whitespace()) {
        bail!("{CODE}: the channel id carries whitespace");
    }
    Ok(destination.to_string())
}

/// A Nostr secret key: `nsec1…` (NIP-19) or 64 hex characters.
///
/// Both spellings are accepted because both are what a person has: a key made by
/// a client is usually handed out as `nsec`, and a key copied out of a config
/// file is hex.
fn secret_key_of(raw: &str) -> Result<k256::schnorr::SigningKey> {
    let raw = raw.trim();
    let bytes: [u8; 32] = if let Some(rest) = raw.strip_prefix("nsec1") {
        use bech32::{Bech32, Hrp};
        let (hrp, data) = bech32::decode(raw)
            .map_err(|error| anyhow::anyhow!("{CODE}: the nsec key is not readable: {error}"))?;
        if hrp != Hrp::parse("nsec").expect("constant hrp") {
            bail!("{CODE}: the key is not an nsec key");
        }
        let _ = std::marker::PhantomData::<Bech32>;
        let _ = rest;
        data.try_into()
            .map_err(|_| anyhow::anyhow!("{CODE}: the nsec key is not 32 bytes"))?
    } else {
        let decoded =
            hex::decode(raw).map_err(|_| anyhow::anyhow!("{CODE}: the private key is not hex"))?;
        decoded
            .try_into()
            .map_err(|_| anyhow::anyhow!("{CODE}: the private key is not 32 bytes"))?
    };
    k256::schnorr::SigningKey::from_bytes((&bytes).into())
        .map_err(|error| anyhow::anyhow!("{CODE}: the private key is not usable: {error}"))
}

/// One signed Nostr event, in the order the canonical form fixes.
struct SignedEvent {
    id: String,
    event: Value,
}

/// Build and sign an event.
///
/// The id is the SHA-256 of the canonical serialization — a JSON array with no
/// whitespace — and the signature is BIP340 over that id. Both are computed here
/// rather than trusted to the transport: a relay verifies them, and a wrong id
/// is refused with no explanation beyond `false`.
fn sign_event(
    key: &k256::schnorr::SigningKey,
    kind: u64,
    tags: Vec<Vec<String>>,
    content: &str,
    created_at: u64,
) -> Result<SignedEvent> {
    use k256::schnorr::signature::hazmat::PrehashSigner;

    let pubkey = hex::encode(key.verifying_key().to_bytes());
    let canonical = serde_json::to_string(&json!([0, pubkey, created_at, kind, tags, content]))
        .context("the event could not be serialized")?;
    let id: [u8; 32] = Sha256::digest(canonical.as_bytes()).into();
    let id_hex = hex::encode(id);
    let signature = key
        .sign_prehash(&id)
        .map_err(|error| anyhow::anyhow!("{CODE}: the event could not be signed: {error}"))?;
    let sig = hex::encode(signature.to_bytes());

    Ok(SignedEvent {
        id: id_hex.clone(),
        event: json!({
            "id": id_hex,
            "pubkey": pubkey,
            "created_at": created_at,
            "kind": kind,
            "tags": tags,
            "content": content,
            "sig": sig,
        }),
    })
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
        .get(PRIVATE_KEY_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no private key is configured"))?;
    let adapter = configured_adapter(&record, &key)?;
    registry.register(CHANNEL, Box::new(adapter))
}

fn configured_adapter(record: &StoredConfig, key: &str) -> Result<BuzzAdapter> {
    check_record(record)?;
    let endpoint = check_endpoint(&record.endpoint)?;
    let channel = channel_of(&record.destination)?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let signing = secret_key_of(key)?;
    Ok(BuzzAdapter {
        url: endpoint.to_string(),
        channel,
        timeout,
        signing,
    })
}

struct BuzzAdapter {
    url: String,
    channel: String,
    timeout: Duration,
    signing: k256::schnorr::SigningKey,
}

impl OutboundAdapter for BuzzAdapter {
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

impl BuzzAdapter {
    async fn deliver(&self, message: &OutboundMessage) -> SendResult {
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        let signed = match sign_event(
            &self.signing,
            GROUP_MESSAGE_KIND,
            vec![vec!["h".to_string(), self.channel.clone()]],
            &envelope_text(message),
            created_at,
        ) {
            Ok(signed) => signed,
            Err(error) => {
                return failed(FailureKind::Terminal, &bounded(&format!("{error:#}")))
            }
        };

        let connect =
            tokio::time::timeout(self.timeout, tokio_tungstenite::connect_async(&self.url)).await;
        let mut socket = match connect {
            Ok(Ok((socket, _))) => socket,
            Ok(Err(error)) => {
                return failed(
                    FailureKind::Retryable,
                    &bounded(&format!("the {LABEL} relay could not be reached: {error}")),
                )
            }
            Err(_) => {
                return failed(
                    FailureKind::Retryable,
                    &bounded(&format!("the {LABEL} relay did not answer in time")),
                )
            }
        };

        let deadline = tokio::time::Instant::now() + self.timeout;
        let mut published = false;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                let _ = socket.close(None).await;
                return failed(
                    FailureKind::Retryable,
                    &bounded(&format!("the {LABEL} relay did not confirm the send in time")),
                );
            }
            let next = tokio::time::timeout(remaining, socket.next()).await;
            let text = match next {
                Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
                Ok(Some(Ok(Message::Close(_)))) | Ok(None) => {
                    return failed(
                        FailureKind::Retryable,
                        &bounded(&format!(
                            "the {LABEL} relay closed before confirming the send"
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
                        &bounded(&format!("the {LABEL} relay went quiet before confirming the send")),
                    );
                }
            };

            let frame: Value = match serde_json::from_str(&text) {
                Ok(frame) => frame,
                Err(_) => continue,
            };
            let Some(array) = frame.as_array() else {
                continue;
            };
            let kind = array.first().and_then(Value::as_str).unwrap_or_default();
            match kind {
                // The relay offers a challenge; publishing without answering it
                // is refused when the relay requires authentication.
                "AUTH" => {
                    let Some(challenge) = array.get(1).and_then(Value::as_str) else {
                        continue;
                    };
                    let auth = match sign_event(
                        &self.signing,
                        AUTH_KIND,
                        vec![
                            vec!["relay".to_string(), self.url.clone()],
                            vec!["challenge".to_string(), challenge.to_string()],
                        ],
                        "",
                        created_at,
                    ) {
                        Ok(auth) => auth,
                        Err(error) => {
                            return failed(FailureKind::Terminal, &bounded(&format!("{error:#}")))
                        }
                    };
                    if let Err(error) = socket
                        .send(Message::Text(json!(["AUTH", auth.event]).to_string()))
                        .await
                    {
                        return failed(
                            FailureKind::Retryable,
                            &bounded(&format!("the {LABEL} auth could not be sent: {error}")),
                        );
                    }
                    continue;
                }
                "NOTICE" => {
                    let notice = array.get(1).and_then(Value::as_str).unwrap_or("refused");
                    return failed(
                        FailureKind::Terminal,
                        &bounded(&format!("the {LABEL} relay refused: {notice}")),
                    );
                }
                "OK" => {
                    // Our answer, or the auth's: only the publish decides.
                    let id = array.get(1).and_then(Value::as_str).unwrap_or_default();
                    if id != signed.id {
                        continue;
                    }
                    let accepted = array.get(2).and_then(Value::as_bool).unwrap_or(false);
                    if accepted {
                        published = true;
                        break;
                    }
                    let reason = array.get(3).and_then(Value::as_str).unwrap_or("refused");
                    return failed(
                        FailureKind::Terminal,
                        &bounded(&format!("the {LABEL} relay refused the message: {reason}")),
                    );
                }
                _ => continue,
            }
        }

        if !published {
            return failed(
                FailureKind::Retryable,
                &bounded(&format!("the {LABEL} relay did not accept the message")),
            );
        }
        // The event id is the handle a later edit or delete would name.
        let _ = socket.close(None).await;
        SendResult::Delivered {
            remote_id: Some(signed.id),
        }
    }
}

#[cfg(test)]
mod tests;
