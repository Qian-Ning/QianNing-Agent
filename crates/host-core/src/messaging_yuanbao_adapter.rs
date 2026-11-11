//! Yuanbao as an outbound channel.
//!
//! The wire lives in [`super::messaging_yuanbao`]; this is the adapter the Host's
//! delivery ledger talks to. Like every other socket-shaped channel here, `send`
//! is synchronous and owns a current-thread runtime for the duration of one
//! delivery: the ledger calls it from a thread it does not want parked.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde::Deserialize;
use tokio_tungstenite::tungstenite::Message;

use super::messaging_adapter::{
    AdapterRegistry, FailureKind, OutboundAdapter, OutboundMessage, SendResult,
};
use super::messaging_outbound::{envelope_text, failed};
use super::messaging_yuanbao::proto::{CmdType, ConnMsg};
use super::messaging_yuanbao::session::{Session, SessionConfig, Target};
use crate::db::Database;
use crate::secrets::SecretStore;

const CHANNEL: &str = "yuanbao";
const SETTINGS_SECTION: &str = "messagingYuanbao";
const FORMAT: &str = "pi-desktop-messaging-yuanbao";
const FORMAT_VERSION: u32 = 1;
const CODE: &str = "messaging.yuanbao";
const APP_ID_SECRET_REF: &str = "secret:messaging-yuanbao:app-id";
const APP_SECRET_SECRET_REF: &str = "secret:messaging-yuanbao:app-secret";
const DEFAULT_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Deserialize)]
struct StoredConfig {
    format: String,
    version: u32,
    endpoint: String,
    destination: String,
    /// The bot's own account. An incoming message is our own echo when it comes
    /// from here, so the channel needs it even to send.
    account: String,
    #[serde(default)]
    request_timeout_ms: Option<u64>,
}

fn check_record(record: &StoredConfig) -> Result<()> {
    if record.format != FORMAT {
        bail!("{CODE}: unsupported settings record '{}'", record.format);
    }
    if record.version != FORMAT_VERSION {
        bail!("{CODE}: unsupported settings version {}", record.version);
    }
    if !(record.endpoint.starts_with("wss://") || record.endpoint.starts_with("ws://")) {
        bail!("{CODE}: the relay address must be a ws:// or wss:// URL");
    }
    if record.destination.trim().is_empty() {
        bail!("{CODE}: no conversation is configured");
    }
    if record.account.trim().is_empty() {
        bail!("{CODE}: no bot account is configured");
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

/// The settings this channel runs on, when a record exists.
///
/// Both the outbound adapter and the inbound loop read the same record, so the
/// reading lives here and neither keeps its own idea of what a valid record is.
pub(crate) fn load_config(
    db: &Database,
    secrets: &SecretStore,
) -> Result<Option<super::messaging_yuanbao::service::ChannelConfig>> {
    let Some(record) = stored_record(db)? else {
        return Ok(None);
    };
    check_record(&record)?;
    let app_id = secrets
        .get(APP_ID_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no application id is configured"))?;
    let app_secret = secrets
        .get(APP_SECRET_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no application secret is configured"))?;
    Ok(Some(super::messaging_yuanbao::service::ChannelConfig {
        url: record.endpoint.clone(),
        app_id,
        app_secret,
        account: record.account.clone(),
    }))
}

fn timeout_of(record: &StoredConfig) -> Duration {
    Duration::from_millis(record.request_timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))
}

pub(crate) fn register(
    registry: &mut AdapterRegistry,
    db: &Database,
    secrets: &SecretStore,
) -> Result<()> {
    let Some(config) = load_config(db, secrets)? else {
        return Ok(());
    };
    let Some(record) = stored_record(db)? else {
        return Ok(());
    };
    let adapter = YuanbaoAdapter {
        url: config.url,
        target: Target::Direct(record.destination.clone()),
        app_id: config.app_id,
        app_secret: config.app_secret,
        account: config.account,
        timeout: timeout_of(&record),
    };
    registry.register(CHANNEL, Box::new(adapter))
}

struct YuanbaoAdapter {
    url: String,
    target: Target,
    app_id: String,
    app_secret: String,
    account: String,
    timeout: Duration,
}

impl OutboundAdapter for YuanbaoAdapter {
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
                    &format!("the {CHANNEL} runtime is unavailable: {error}"),
                )
            }
        };
        runtime.block_on(self.deliver(message))
    }
}

impl YuanbaoAdapter {
    async fn deliver(&self, message: &OutboundMessage) -> SendResult {
        match tokio::time::timeout(self.timeout, self.attempt(message)).await {
            Ok(result) => result,
            Err(_) => failed(
                FailureKind::Retryable,
                &format!("the {CHANNEL} relay did not answer in time"),
            ),
        }
    }

    async fn attempt(&self, message: &OutboundMessage) -> SendResult {
        let dial = tokio_tungstenite::connect_async(self.url.as_str()).await;
        let (mut socket, _) = match dial {
            Ok(pair) => pair,
            // A relay that cannot be reached is worth another attempt later.
            Err(error) => return failed(FailureKind::Retryable, &format!("{CODE}: {error}")),
        };

        let mut session = Session::new(SessionConfig::new(
            self.app_id.clone(),
            self.app_secret.clone(),
            self.account.clone(),
        ));
        if let Err(error) = socket.send(Message::Binary(session.auth_frame())).await {
            return failed(FailureKind::Retryable, &format!("{CODE}: {error}"));
        }

        // The relay answers the handshake before it will accept a send.
        match self.await_auth(&mut socket, &mut session).await {
            Ok(true) => {}
            Ok(false) => {
                return failed(
                    FailureKind::Terminal,
                    &format!("{CODE}: the relay did not accept the credentials"),
                )
            }
            Err(detail) => return failed(FailureKind::Retryable, &detail),
        }

        let frame = session.text_frame(&self.target, &message.id, &envelope_text(message));
        if let Err(error) = socket.send(Message::Binary(frame)).await {
            return failed(FailureKind::Retryable, &format!("{CODE}: {error}"));
        }

        // Closing is best-effort: the message is already on the wire.
        let _ = socket.close(None).await;
        SendResult::Delivered { remote_id: None }
    }

    async fn await_auth(
        &self,
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        session: &mut Session,
    ) -> Result<bool, String> {
        while let Some(frame) = socket.next().await {
            let frame = frame.map_err(|error| format!("{CODE}: {error}"))?;
            let Message::Binary(bytes) = frame else {
                continue;
            };
            let Ok(msg) = ConnMsg::decode(bytes.as_slice()) else {
                continue;
            };
            let head = msg.head.clone().unwrap_or_default();
            if CmdType::from_i32(head.cmd_type) != Some(CmdType::Response)
                || head.cmd != "auth-bind"
            {
                continue;
            }
            // `on_frame` records the successful handshake on the session; the
            // status is what the caller has to branch on.
            let _ = session.on_frame(&bytes);
            return Ok(head.status == 0);
        }
        Err(format!(
            "{CODE}: the relay closed before answering the handshake"
        ))
    }
}

#[cfg(test)]
mod tests;
