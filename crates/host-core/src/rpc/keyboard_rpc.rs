use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, AppState, JsonRpcError};

/// Handles the `keyboard*` family.
pub(super) async fn handle(
    _state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "keyboard.setGlobalShortcut" => {
            let binding = params
                .get("binding")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let enabled = crate::keyboard::uses_windows_fallback(binding);
            crate::keyboard::set_enabled(enabled);
            Ok(json!({ "enabled": enabled }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
