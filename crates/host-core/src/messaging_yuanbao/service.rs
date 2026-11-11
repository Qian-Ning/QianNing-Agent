//! The loop as a thing that can be started and stopped.
//!
//! [`socket::run`] is one connection; this owns the dialling, the retry delay and
//! the shutdown flag, so the host can say "start this channel" and "stop it" and
//! not think about sockets.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use super::session::{InboundMessage, Session, SessionConfig};
use super::socket::{self, ConnectionError, ConnectionEvent};

/// How long to wait before dialling again after a connection ends.
pub const RETRY_DELAY: Duration = Duration::from_secs(5);

/// Everything a channel needs in order to run.
#[derive(Clone, Debug)]
pub struct ChannelConfig {
    pub url: String,
    pub app_id: String,
    pub app_secret: String,
    /// The bot's own account; messages from it are our own echo.
    pub account: String,
    /// The session an incoming message opens a turn in. `None` means the record
    /// is send-only.
    pub session_id: Option<String>,
}

impl ChannelConfig {
    fn session(&self) -> Session {
        Session::new(SessionConfig::new(
            self.app_id.clone(),
            self.app_secret.clone(),
            self.account.clone(),
        ))
    }
}

/// A running channel. Dropping it stops the loop.
pub struct Running {
    stop: Arc<AtomicBool>,
    handle: tokio::task::JoinHandle<()>,
}

impl Running {
    /// Ask the loop to stop after the current connection ends or immediately,
    /// whichever comes first.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    /// Wait for the loop task to finish.
    pub async fn join(self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.handle.await;
    }
}

/// Start a channel: authenticate, then keep reconnecting until stopped.
///
/// `messages` receives everything the session considers a new turn. The sender is
/// unbounded on purpose — a message must not be dropped because the reader was
/// momentarily behind, and the runtime applies its own backpressure per turn.
pub fn start(config: ChannelConfig, messages: UnboundedSender<InboundMessage>) -> Running {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let handle = tokio::spawn(async move {
        loop {
            if flag.load(Ordering::Relaxed) {
                return;
            }
            let outcome = socket::run(&config.url, config.session(), |event| {
                if let ConnectionEvent::Message(message) = event {
                    let _ = messages.send(message);
                }
            })
            .await;

            match outcome {
                Ok(()) => return,
                Err(ConnectionError::NotAuthenticated) => {
                    // Retrying will not fix a rejected credential.
                    return;
                }
                Err(_) => {
                    if flag.load(Ordering::Relaxed) {
                        return;
                    }
                    tokio::time::sleep(RETRY_DELAY).await;
                }
            }
        }
    });
    Running { stop, handle }
}

/// Start the channel from the settings record, if there is one, and keep it
/// running for as long as the caller does.
///
/// Every message the relay pushes is forwarded as one `messaging.inbound`
/// notification carrying the projected fields, which is the single seam this
/// channel adds between host-core and the runtime (see the ADR).
pub async fn run_configured(
    state: std::sync::Arc<tokio::sync::Mutex<crate::state::AppState>>,
    tx: tokio::sync::mpsc::UnboundedSender<String>,
) {
    let config = {
        let st = state.lock().await;
        match crate::messaging_yuanbao_adapter::load_config(&st.db, &st.secrets) {
            Ok(config) => config,
            Err(error) => {
                tracing::warn!(%error, "inbound yuanbao channel is not available");
                return;
            }
        }
    };
    let Some(config) = config else {
        return;
    };
    // A send-only record has no place to put an incoming message, so the loop
    // does not start. The panel's gate requires this field anyway; this is the
    // backstop for a record written before that gate existed.
    if config.session_id.is_none() {
        tracing::info!("inbound yuanbao channel is not configured with a session");
        return;
    }

    let session_id = config.session_id.clone();
    let (messages, mut incoming) = tokio::sync::mpsc::unbounded_channel::<InboundMessage>();
    let running = start(config, messages);

    while let Some(message) = incoming.recv().await {
        let params = serde_json::json!({
            "channel": "yuanbao",
            "sessionId": session_id,
            "id": message.id,
            "conversation": message.conversation,
            "sender": message.sender,
            "senderName": message.sender_name,
            "text": message.text,
            "sentAt": message.sent_at,
            "inGroup": message.in_group,
        });
        let note = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "messaging.inbound",
            "params": params,
        });
        if let Ok(raw) = serde_json::to_string(&note) {
            if tx
                .send(format!(
                    "{raw}
"
                ))
                .is_err()
            {
                break;
            }
        }
    }

    running.join().await;
}

#[cfg(test)]
mod tests;
