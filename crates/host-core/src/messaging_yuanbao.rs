//! Yuanbao (腾讯元宝) as a messaging channel.
//!
//! The relay speaks protobuf over a WebSocket, one frame per message; the wire
//! shapes live in [`proto`]. The socket loop and the session machine sit on top
//! of them.

pub mod proto;
pub mod session;
pub mod socket;
