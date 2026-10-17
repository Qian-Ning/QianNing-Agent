//! The outbound Mattermost channel (ADR 0205 D375 item 9, rollout R3).
//!
//! This is the fourth chat channel that delivers the same redacted summary the
//! webhook, Telegram, Slack and Discord channels already carry, over the
//! platform's own outbound send API: one JSON POST per attempt to the endpoint
//! the user configured, classified for the delivery ledger. It follows the
//! Slack channel's structure and shares the transport machinery in
//! [`crate::messaging_outbound`] rather than restating it.
//!
//! # Direction: outbound delivery only
//!
//! This module only sends. It never binds, listens, accepts, or opens a socket:
//! the one connection it makes is a client request *to* the configured
//! endpoint, so the acceptance scenario's precondition — no inbound port is open
//! on the Host machine — stays true.
//!
//! **Mattermost inbound does not live here.** Its incoming direction is a
//! websocket push (`/api/v4/websocket`); that client is JavaScript and lives in
//! the agent host module
//! (`packages/agent-host/src/messaging-mattermost-inbound.ts`), which owns the
//! socket, the auth challenge, the reply's `root_id`, and the chunked reply send
//! path for reply *text*. The **Rust** tree still has no websocket client, so
//! this module stays outbound only. It also does not chunk: what the ledger
//! hands it is one bounded redacted summary — the same shape the Slack channel
//! posts in one request — and a chunker here would be a second copy of the
//! platform rule the JavaScript send path already owns.
//!
//! # How one attempt is classified
//!
//! Mattermost answers a refusal with an HTTP status, so the status is the
//! answer: a 2xx is the receiver's acceptance; 429 and 5xx are "not now" and
//! stay retryable; every other status — the other 4xx, and a 3xx the client
//! refuses to follow because a redirected POST would carry the access token
//! somewhere else — refuses this delivery for good. That is the shared status
//! rule ([`crate::messaging_outbound::classify_status`]), unchanged.
//!
//! # Configuration
//!
//! There is no migration and no schema change: the record is read from the same
//! key/value settings row every other host feature reads
//! (`Database::get_setting("app")`), under a `messagingMattermost` section — the
//! section the settings write path and the inbound wiring already use.
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-mattermost",
//!   "version": 1,
//!   "endpoint": "https://chat.example.invalid",
//!   "destination": "<channel id>",
//!   "requestTimeoutMs": 10000
//! }
//! ```
//!
//! `destination` is the channel the summary is sent to; a post at channel level
//! carries no `root_id`, which is exactly what the inbound client's send path
//! does for a channel-level reply. The access token is read from the secret
//! store under `secret:messaging-mattermost:access-token`, the ref the inbound
//! client and the settings panel already use.
//!
//! An absent or null section registers nothing at all: the Host runs the same
//! whether the channel is configured or not, and a configured channel registers
//! alongside the others — several channels coexist, distinguished by the
//! ledger's channel column.
//!
//! # The credential
//!
//! Mattermost takes a personal access token as `Bearer <token>` in the
//! `Authorization` header. The value is marked sensitive so nothing that
//! formats a request can reveal it, the token never enters a URL, and the
//! failure details name the channel and the status, never the address or the
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
pub(crate) const CHANNEL: &str = "mattermost";

/// The settings section the record lives in, inside the existing `app` row.
const SETTINGS_SECTION: &str = "messagingMattermost";
/// The record's self-identifying format, beside its siblings' own.
const FORMAT: &str = "pi-desktop-messaging-mattermost";
const FORMAT_VERSION: u32 = 1;
/// Where the access token lives in the secret store.
const ACCESS_TOKEN_SECRET_REF: &str = "secret:messaging-mattermost:access-token";

/// The error code every refusal here carries, beside its siblings' own.
const CODE: &str = "MESSAGING_MATTERMOST_INVALID";
/// The channel's own word for itself, used only to build failure details.
const LABEL: &str = "mattermost";
/// The send method the platform's outbound API exposes, appended to the
/// configured endpoint.
const SEND_METHOD: &str = "api/v4/posts";
/// The platform's field naming the destination channel, mapped from our own
/// vocabulary.
const DESTINATION_FIELD: &str = "channel_id";
/// The platform's field carrying the message body.
const MESSAGE_FIELD: &str = "message";

/// The stored record, exactly as the `messagingMattermost` settings section
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
            "{CODE}: unsupported mattermost settings record '{}'",
            record.format
        );
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: mattermost settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

/// The address one attempt posts to, validated by the shared endpoint rule.
///
/// The endpoint is validated on its own, without the credential; the send URL
/// only appends the API path to an address that already passed the rule, and a
/// base path the user configured (a reverse proxy under `/chat`) survives.
fn send_url(record: &StoredConfig, allow_insecure_http: bool) -> Result<reqwest::Url> {
    check_record(record)?;
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    // Built by hand rather than with `Url::join`, whose last-segment rules would
    // silently drop a base path such as `/chat`.
    let base = endpoint.as_str().trim_end_matches('/');
    reqwest::Url::parse(&format!("{base}/{SEND_METHOD}"))
        .with_context(|| format!("{CODE}: the endpoint does not form a send URL"))
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
        .with_context(|| format!("{CODE}: the mattermost settings could not be read"))?;
    Ok(Some(record))
}

/// Register the Mattermost channel into the Host's registry when one is
/// configured, and register nothing when none is.
///
/// Called from the state construction the Host already owns, beside the other
/// channel registrations, so the existing attempt-cycle driver reaches the
/// channel with no new dispatch arm and no second registry. A Host with no
/// record is not an error: it simply has no Mattermost channel. Every other
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
    // The access token is this channel's only credential, and the platform's
    // API cannot be reached without it, so its absence is a configuration error
    // rather than a channel that posts anonymously.
    let token = secrets
        .get(ACCESS_TOKEN_SECRET_REF)?
        .ok_or_else(|| anyhow::anyhow!("{CODE}: no access token is configured"))?;
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
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination channel is empty");
    }
    let destination = destination.to_string();
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let authorization = Some(authorization_header("Bearer", token, CODE, "access token")?);
    let body: BodyBuilder = Box::new(move |message| {
        serde_json::json!({
            DESTINATION_FIELD: destination,
            MESSAGE_FIELD: envelope_text(message),
        })
    });
    let config = ChannelConfig::new(url, authorization, timeout, body);
    let mut adapter = HttpChannelAdapter::new(LABEL).configure(config);
    adapter.connect()?;
    Ok(adapter)
}

#[cfg(test)]
mod tests;
