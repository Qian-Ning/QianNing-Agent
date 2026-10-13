//! Handles the `network.*` family: outbound proxy state the desktop resolves
//! and the host mirrors.
//!
//! The desktop owns proxy discovery because Electron can ask the OS for the
//! system/PAC result; the host only needs to know how to reach the network. The
//! relay URL is therefore runtime-only state, pushed over RPC at startup —
//! it never reaches host-core's environment or its stored settings.

use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};

/// Handles the `network.*` family.
///
/// `_state` is unused today and present so every family handler keeps the same
/// signature the dispatcher calls.
pub(super) async fn handle(
    _state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        // Electron resolves the system/PAC proxy itself and exposes the result
        // as an ephemeral, loopback-only, credential-bearing SOCKS relay.
        // `set_system_proxy_relay` re-validates the shape (internal route, a
        // 64-hex credential, IPv4 loopback) before it is used for outbound
        // requests, so a malformed value is rejected rather than trusted.
        "network.configureSystemProxyRelay" => {
            let url = params
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "url required", "INVALID_PARAMS"))?;
            crate::network_proxy::set_system_proxy_relay(url)
                .map_err(|message| rpc_err(1002, message, "INVALID_PARAMS"))?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
