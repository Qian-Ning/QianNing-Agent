//! The outbound Slack channel (ADR 0205 D375 item 9, rollout R3).
//!
//! This is the second of the two chat channels that deliver the same redacted
//! summary the webhook channel already carries, over the platform's outbound
//! send API: one JSON POST per attempt to the endpoint the user configured,
//! classified for the delivery ledger. It follows the webhook channel's
//! structure and shares the transport machinery in
//! [`crate::messaging_outbound`] rather than restating it — the request worker,
//! the transport classification, the endpoint rule, and the delivery envelope
//! all live there.
//!
//! # Direction: outbound delivery, and Slack inbound is deferred
//!
//! This module only sends. It never binds, listens, accepts, or long-polls:
//! the one socket it opens is a client connection *to* the configured
//! endpoint, and the acceptance scenario's precondition — no inbound port is
//! open on the Host machine — stays true. (The Telegram channel now also
//! receives inbound commands, but by a long poll run in the agent host module,
//! not here.)
//!
//! **Slack inbound is deferred.** Its incoming direction needs socket mode,
//! which needs a websocket client, and this tree has none; adding that
//! dependency is the maintainer's decision. Outbound Slack is unchanged.
//!
//! The inbound command path that does exist belongs to the Telegram channel and
//! is delivered by the messaging integration's driver in the agent host module,
//! beside the turn and approval operations it invokes, reached by an outbound
//! long poll of its own. This module holds none of it: no message receive, no
//! polling loop, no command mapping, no chat-to-principal link, no
//! request-context mint, no inbound replay guard, and no own permission policy.
//!
//! # The lock rule
//!
//! No attempt holds the host state lock across a blocking send, on any path
//! including error and early returns. This channel touches no guarded Host state
//! at all: its endpoint, credential, and timeout are resolved once at
//! registration ([`register`]), before any attempt runs, and the attempt cycle
//! releases the lock before it calls `send`. If reading configuration or a
//! credential were ever needed at send time, it would have to be read, then
//! released, before the send — the discipline the webhook's attempt cycle
//! already gets right.
//!
//! # How one attempt is classified
//!
//! The platform's send API answers a refusal with HTTP 200 and a JSON body, so
//! this channel reads the body and the body is the answer: `{"ok":true}` is the
//! receiver's acceptance. A `{"ok":false,"error":"..."}` whose error names an
//! authentication, channel, membership, or payload problem ends this delivery
//! terminally and carries that error into the ledger's last error, the only
//! diagnostic the operator gets; a rate limit or a transient server fault stays
//! retryable. A 2xx whose body cannot be read, and a 2xx whose body carries no
//! acceptance flag, is not an acceptance and stays retryable. A non-2xx status
//! keeps the status rule the shared transport applies: 429 and 5xx are the
//! receiver saying "not now" and stay retryable, and every other status — the
//! other 4xx, and a 3xx the client refuses to follow because a redirected POST
//! would carry the bearer token somewhere else — refuses this delivery for good.
//! A timeout, a connection that could not be established, and a response body
//! that could not be read stay retryable; a response the client cannot accept
//! ends the delivery terminally.
//! [`crate::messaging_outbound::classify_transport`] records the one place where
//! the client's public error surface cannot separate two of those cases.
//!
//! # Configuration
//!
//! There is no migration and no schema change: the record is read from the same
//! key/value settings row every other host feature reads
//! (`Database::get_setting("app")`), under a `messagingSlack` section. That is
//! the mechanism `networkPolicy` and the webhook channel's `messagingWebhook`
//! section already use, so the settings write path can carry the section through
//! the existing `settings.set` verb with no new host verb and no new namespace.
//! The bot token is read from the secret store under
//! `secret:messaging-slack:bot-token`, the shape config sync already uses for
//! its own credential (`secret:config-sync:webdav-password`).
//!
//! ```json
//! {
//!   "format": "pi-desktop-messaging-slack",
//!   "version": 1,
//!   "endpoint": "https://example.invalid/api",
//!   "destination": "<channel id>",
//!   "requestTimeoutMs": 10000
//! }
//! ```
//!
//! `format` and `version` follow the config-sync record so a record written by a
//! later build is refused instead of half-read. `destination` is the channel the
//! summary is sent to. `requestTimeoutMs` is optional and defaults to
//! [`crate::messaging_outbound::DEFAULT_REQUEST_TIMEOUT`]. An absent or null
//! section registers nothing at all: the Host runs the same whether the channel
//! is configured or not, and a configured channel registers alongside the
//! webhook — several channels coexist, distinguished by the ledger's channel
//! column.
//!
//! The endpoint rule is the webhook's, applied by calling the same shared
//! helper: HTTPS is required, and a plaintext hop is accepted only to the user's
//! own LAN under the relaxed policy. The bot token is the platform's own
//! credential and is sent the platform's own way — as an `Authorization: Bearer`
//! header, which is what its API specifies and not a scheme invented here. The
//! header value is marked sensitive so nothing that formats a request can reveal
//! it, and the failure details name the channel and the status, never the
//! address or the credential.

use anyhow::{bail, Context, Result};

use crate::db::Database;
use crate::messaging_adapter::{AdapterRegistry, OutboundAdapter};
use crate::messaging_outbound::{
    bearer_header, envelope_text, request_timeout, validate_https_endpoint, BodyBuilder,
    ChannelConfig, HttpChannelAdapter,
};
use crate::secrets::SecretStore;

/// The delivery channel this adapter serves and the name it registers under.
///
/// The registry's name *is* the ledger's channel, so the Host wiring that
/// redacts an event and calls `messaging.enqueue` must enqueue to this value;
/// anything else is refused before it is persisted.
pub(crate) const CHANNEL: &str = "slack";

/// The settings section the record lives in, inside the existing `app` row.
const SETTINGS_SECTION: &str = "messagingSlack";
/// The record's self-identifying format, beside the webhook's own.
const FORMAT: &str = "pi-desktop-messaging-slack";
const FORMAT_VERSION: u32 = 1;
/// Where the bot token lives in the secret store.
const BOT_TOKEN_SECRET_REF: &str = "secret:messaging-slack:bot-token";

/// The error code every refusal here carries, beside the webhook's own.
const CODE: &str = "MESSAGING_SLACK_INVALID";
/// The channel's own word for itself, used only to build failure details.
const LABEL: &str = "slack";
/// The send method the platform's outbound API exposes, appended to the
/// configured endpoint.
const SEND_METHOD: &str = "chat.postMessage";
/// The platform's field naming the destination, mapped from our own vocabulary.
const DESTINATION_FIELD: &str = "channel";

/// The stored record, exactly as the `messagingSlack` settings section carries
/// it.
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
            "{CODE}: unsupported slack settings record '{}'",
            record.format
        );
    }
    if record.version != FORMAT_VERSION {
        bail!(
            "{CODE}: slack settings version {} is not supported",
            record.version
        );
    }
    Ok(())
}

/// The address one attempt posts to, validated by the shared endpoint rule.
///
/// The endpoint is validated on its own, without the credential; the send URL
/// only appends the method to an address that already passed the rule.
fn send_url(record: &StoredConfig, allow_insecure_http: bool) -> Result<reqwest::Url> {
    check_record(record)?;
    let endpoint = validate_https_endpoint(&record.endpoint, allow_insecure_http, CODE)?;
    // Built by hand rather than with `Url::join`, whose last-segment rules would
    // silently drop a base path such as `/api`.
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
        .with_context(|| format!("{CODE}: the slack settings could not be read"))?;
    Ok(Some(record))
}

/// Register the Slack channel into the Host's registry when one is configured,
/// and register nothing when none is.
///
/// Called from the state construction the Host already owns, beside the webhook
/// and Telegram registrations, so the existing attempt-cycle driver reaches the
/// channel with no new dispatch arm and no second registry. A Host with no
/// record is not an error: it simply has no Slack channel. Every other failure —
/// a record this build cannot read, an endpoint the policy refuses, a missing
/// credential — is returned so the caller can report it without failing the
/// boot.
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
    let destination = record.destination.trim();
    if destination.is_empty() {
        bail!("{CODE}: the destination channel is empty");
    }
    let destination = destination.to_string();
    let timeout = request_timeout(record.request_timeout_ms, CODE)?;
    let authorization = Some(bearer_header(token, CODE)?);
    let body: BodyBuilder = Box::new(move |message| {
        serde_json::json!({
            DESTINATION_FIELD: destination,
            "text": envelope_text(message),
        })
    });
    let config = ChannelConfig::new(url, authorization, timeout, body).with_body_outcome();
    let mut adapter = HttpChannelAdapter::new(LABEL).configure(config);
    adapter.connect()?;
    Ok(adapter)
}

#[cfg(test)]
mod tests;
