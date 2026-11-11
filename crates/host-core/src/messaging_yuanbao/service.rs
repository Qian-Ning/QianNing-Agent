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

#[cfg(test)]
mod tests;
