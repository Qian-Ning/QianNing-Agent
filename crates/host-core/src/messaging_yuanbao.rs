//! Yuanbao (腾讯元宝) as a messaging channel.
//!
//! The relay speaks protobuf over a WebSocket, one frame per message; the wire
//! shapes live in [`proto`]. The connection work — authenticate, keep alive,
//! send, receive — sits on top of them.

pub mod proto;
