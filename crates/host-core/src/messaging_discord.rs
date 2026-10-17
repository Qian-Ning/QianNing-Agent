//! The outbound Discord channel (ADR 0205 D375 item 9, rollout R3).
//!
//! This is the third chat channel that delivers the same redacted summary the
//! webhook, Telegram and Slack channels already carry, over the platform's own
//! outbound send API: one JSON POST per attempt to the endpoint the user
//! configured, classified for the delivery ledger. It follows the Slack
//! channel's structure and shares the transport machinery in
//! [`crate::messaging_outbound`] rather than restating it — the request worker,
//! the transport classification, the endpoint rule, the request-timeout and
//! credential validation, and the delivery envelope all live there.
//!
//! # Direction: outbound delivery only
//!
//! This module only sends. It never binds, listens, accepts, or opens a socket:
//! the one connection it makes is a client request *to* the configured
//! endpoint, so the acceptance scenario's precondition — no inbound port is open
//! on the Host machine — stays true.
//!
//! **Discord inbound does not live here.** Its incoming direction is a Gateway
//! push; that client is JavaScript and lives in the agent host module
//! (`packages/agent-host/src/messaging-discord-inbound.ts`), which owns the
//! websocket, the heartbeat, the resume and the chunked reply send path for
//! reply *text*. The **Rust** tree still has no websocket client, so this module
//! stays outbound only. It also does not chunk: what the ledger hands it is one
//! bounded redacted summary — the same shape the Slack channel posts in one
//! request — and a chunker here would be a second copy of the platform rule the
//! JavaScript send path already owns.
//!
//! # How one attempt is classified
//!
//! Discord answers a refusal with an HTTP status, so the status is the answer:
//! a 2xx is the receiver's acceptance; 429 (the JSON body's `retry_after` is
//! the platform's own back-off) and 5xx are "not now" and stay retryable; every
//! other status — the other 4xx, and a 3xx the client refuses to follow because
//! a redirected POST would carry the bot token somewhere else — refuses this
//! delivery for good. That is the shared status rule
//! ([`crate::messaging_outbound::classify_status`]), unchanged.
//!
//! # Configuration
//!
//! There is no migration and no schema change: the record is read from the same
//! key/value settings row every other host feature reads
//! (`Database::get_setting("app")`), under a `messagingDiscord` section — the
//! section the settings write path and the inbound wiring already use.
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-discord",
//!   "version": 1,
//!   "endpoint": "https://discord.com/api/v10",
//!   "destination": "<channel id>",
//!   "requestTimeoutMs": 10000
//! }
//! ```
//!
//! `destination` is the channel the summary is sent to. In Discord a thread is
//! its own channel, so a thread's id is the target of a reply that belongs in
//! that thread — the same rule the inbound client applies when it normalises a
//! message. The bot token is read from the secret store under
//! `secret:messaging-discord:bot-token`, the ref the inbound client and the
//! settings panel already use.
//!
//! An absent or null section registers nothing at all: the Host runs the same
//! whether the channel is configured or not, and a configured channel registers
//! alongside the others — several channels coexist, distinguished by the
//! ledger's channel column.
//!
//! # The credential
//!
//! Discord's send API takes a bot token as `Bot <token>` in the
//! `Authorization` header, which is what its API specifies and not a scheme
//! invented here. The header value is marked sensitive so nothing that formats
//! a request can reveal it, the token never enters a URL, and the failure
//! details name the channel and the status, never the address or the
//! credential.

use anyhow::{bail, Context, Result};

use crate::db::Database;
use crate::messaging_adapter::{AdapterRegistry, OutboundAdapter};
use crate::messaging_outbound::{
    authorization_header, envelope_text, request_timeout, validate_https_endpoint, BodyBuilder,
    ChannelConfig, HttpChannelAdapter,
};
use crate::secrets::SecretStore;

/// The delivery channel this adapter serves and the name it registers under.
///
/// The registry's name *is* the ledger's channel, so the Host wiring that
/// redacts an event and calls `messaging.enqueue` must enqueue to this value;
/// anything else is refused before it is persisted.
pub(crate) const CHANNEL: &str = "discord";

/// The settings section the record lives in, inside the existing `app` row.
const SETTINGS_SECTION: &str = "messagingDiscord";
/// The record's self-identifying format, beside its siblings' own.
const FORMAT: &str = "pi-desktop-messaging-discord";
const FORMAT_VERSION: u32 = 1;
/// Where the bot token lives in the secret store.
const BOT_TOKEN_SECRET_REF: &str = "secret:messaging-discord:bot-token";

/// The error code every refusal here carries, beside its siblings' own.
const CODE: &str = "MESSAGING_DISCORD_INVALID";
/// The channel's own word for itself, used only to build failure details.
const LABEL: &str = "discord";
/// The credential scheme Discord's API specifies for a bot token.
const AUTHORIZATION_SCHEME: &str = "Bot";
/// The path the platform's send API exposes, between the endpoint and the
/// channel, and after it.
const CHANNELS_PATH: &str = "channels";
const MESSAGES_METHOD: &str = "messages";
/// The platform's field carrying the message body.
const CONTENT_FIELD: &str = "content";

/// The stored record, exactly as the `messagingDiscord` settings section
/// carries it.
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

/// Validate the record's self-identifying header.
fn check_record(record: &StoredConfig) -> Result<()> {
    if record.format != FORMAT {
        bail!(
            "{CODE}: unsupported discord settings record '{}'",
            record.format
        );
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: discord settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

/// Percent-encode one path segment, so a channel id can never leave the path
/// it is meant to occupy. Discord ids are decimal, so this is an identity for
/// every real target; it exists so a malformed id is a wrong-looking URL rather
/// than a request aimed at another route.
fn encode_segment(segment: &str) -> String {
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// The address one attempt posts to, validated by the shared endpoint rule.
///
/// The destination is a path segment of the send URL — Discord addresses the
/// channel, not a body field — so it is validated and encoded before the
/// address is built, and the endpoint itself is judged without the credential.
fn send_url(record: &StoredConfig, allow_insecure_http: bool) -> Result<reqwest::Url> {
    check_record(record)?;
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination channel is empty");
    }
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    // Built by hand rather than with `Url::join`, whose last-segment rules would
    // silently drop a base path such as `/api/v10`.
    let base = endpoint.as_str().trim_end_matches('/');
    reqwest::Url::parse(&format!(
        "{base}/{CHANNELS_PATH}/{}/{MESSAGES_METHOD}",
        encode_segment(destination)
    ))
    .with_context(|| format!("{CODE}: the endpoint and destination do not form a send URL"))
}

/// The stored record, if the Host has one.
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
        .with_context(|| format!("{CODE}: the discord settings could not be read"))?;
    Ok(Some(record))
}

/// Register the Discord channel into the Host's registry when one is
/// configured, and register nothing when none is.
///
/// Called from the state construction the Host already owns, beside the other
/// channel registrations, so the existing attempt-cycle driver reaches the
/// channel with no new dispatch arm and no second registry. A Host with no
/// record is not an error: it simply has no Discord channel. Every other
/// failure — a record this build cannot read, an endpoint the policy refuses, a
/// missing credential — is returned so the caller can report it without failing
/// the boot.
pub(crate) fn register(
    registry: &mut AdapterRegistry,
    db: &Database,
    secrets: &SecretStore,
) -> Result<()> {
    let Some(record) = stored_record(db)? else {
        return Ok(());
    };
    // The bot token is this channel's only credential, and the platform's API
    // cannot be reached without it, so its absence is a configuration error
    // rather than a channel that posts anonymously.
    let token = secrets
        .get(BOT_TOKEN_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no bot token is configured"))?;
    let adapter = configured_adapter(&record, &token, crate::network_policy::relaxed())?;
    registry.register(CHANNEL, Box::new(adapter))
}

/// Build and connect the adapter a configured record and credential describe.
///
/// Shared by [`register`] and the tests, so a test drives exactly the adapter
/// the Host would register.
fn configured_adapter(
    record: &StoredConfig,
    token: &str,
    allow_insecure_http: bool,
) -> Result<HttpChannelAdapter> {
    let url = send_url(record, allow_insecure_http)?;
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let authorization = Some(authorization_header(
        AUTHORIZATION_SCHEME,
        token,
        CODE,
        "bot token",
    )?);
    let body: BodyBuilder = Box::new(move |message| {
        serde_json::json!({
            CONTENT_FIELD: envelope_text(message),
            // The envelope carries ids the platform could read as mentions;
            // asking it to parse none keeps a delivery from pinging anyone.
            "allowed_mentions": { "parse": [] },
        })
    });
    let config = ChannelConfig::new(url, authorization, timeout, body);
    let mut adapter = HttpChannelAdapter::new(LABEL).configure(config);
    adapter.connect()?;
    Ok(adapter)
}

#[cfg(test)]
mod tests;
