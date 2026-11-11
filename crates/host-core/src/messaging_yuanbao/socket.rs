//! The socket the session state machine talks through.
//!
//! One WebSocket connection: authenticate, keep it alive with pings, hand every
//! incoming frame to [`Session`], and write back whatever the session answers.
//! Reconnection is deliberately outside: the caller decides when to dial again,
//! because the reason a connection dropped is what decides whether redialling is
//! sensible.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use super::session::{InboundMessage, Session};

/// How often the connection pings the relay.
pub const PING_INTERVAL: Duration = Duration::from_secs(30);

/// How long a dial is allowed to take before it is treated as failed.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
pub enum ConnectionError {
    Dial(String),
    /// The relay closed the socket, or the socket failed.
    Closed(String),
    /// The relay refused the credentials.
    NotAuthenticated,
}

impl std::fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectionError::Dial(e) => write!(f, "could not reach the relay: {e}"),
            ConnectionError::Closed(e) => write!(f, "the relay connection ended: {e}"),
            ConnectionError::NotAuthenticated => {
                write!(f, "the relay did not accept the credentials")
            }
        }
    }
}

impl std::error::Error for ConnectionError {}

/// What the loop reports while it runs.
#[derive(Debug)]
pub enum ConnectionEvent {
    /// The relay accepted the credentials; sends are allowed from here on.
    Ready,
    Message(InboundMessage),
    /// A reply the relay sent for a send request, carrying its status.
    SendResult {
        msg_id: String,
        status: u64,
    },
}

/// A live connection. Sends are queued through it; inbound work arrives on the
/// event callback the loop was started with.
pub type LiveConnection =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Dial, authenticate, then run until the socket ends.
///
/// `on_event` is called for everything the session considers worth reporting.
/// Returning an error or closing the returned sender stops the loop, which is
/// how cancellation works here.
pub async fn run<F>(url: &str, mut session: Session, mut on_event: F) -> Result<(), ConnectionError>
where
    F: FnMut(ConnectionEvent) + Send,
{
    let dial = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url));
    let (mut socket, _) = match dial.await {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return Err(ConnectionError::Dial(e.to_string())),
        Err(_) => return Err(ConnectionError::Dial("timed out".into())),
    };

    let auth = session.auth_frame();
    socket
        .send(Message::Binary(auth))
        .await
        .map_err(|e| ConnectionError::Closed(e.to_string()))?;

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await; // the first tick fires immediately

    loop {
        tokio::select! {
            _ = ping.tick() => {
                let frame = session.ping_frame();
                socket
                    .send(Message::Binary(frame))
                    .await
                    .map_err(|e| ConnectionError::Closed(e.to_string()))?;
            }
            incoming = socket.next() => {
                let Some(frame) = incoming else {
                    return Err(ConnectionError::Closed("stream ended".into()));
                };
                let frame = frame.map_err(|e| ConnectionError::Closed(e.to_string()))?;
                match frame {
                    Message::Binary(bytes) => {
                        let was_authenticated = session.is_authenticated();
                        let step = session
                            .on_frame(&bytes)
                            .map_err(|e| ConnectionError::Closed(e.to_string()))?;
                        if let Some(reply) = step.reply {
                            socket
                                .send(Message::Binary(reply))
                                .await
                                .map_err(|e| ConnectionError::Closed(e.to_string()))?;
                        }
                        if !was_authenticated && session.is_authenticated() {
                            on_event(ConnectionEvent::Ready);
                        }
                        for message in step.messages {
                            on_event(ConnectionEvent::Message(message));
                        }
                    }
                    Message::Ping(payload) => {
                        socket
                            .send(Message::Pong(payload))
                            .await
                            .map_err(|e| ConnectionError::Closed(e.to_string()))?;
                    }
                    Message::Close(_) => {
                        return Err(ConnectionError::Closed("closed by the relay".into()));
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Send one text message on an already-authenticated connection.
pub async fn send_text(
    socket: &mut LiveConnection,
    session: &mut Session,
    target: &super::session::Target,
    msg_id: &str,
    text: &str,
) -> Result<(), ConnectionError> {
    let frame = session.text_frame(target, msg_id, text);
    socket
        .send(Message::Binary(frame))
        .await
        .map_err(|e| ConnectionError::Closed(e.to_string()))
}

#[cfg(test)]
mod tests;
